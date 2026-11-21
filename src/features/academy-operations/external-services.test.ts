import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createExternalServices } from './external-services.ts';

function wav(seconds = 1) {
  const bytes = new Uint8Array(44 + seconds * 32000),
    view = new DataView(bytes.buffer);
  for (const [at, value] of [
    [0, 'RIFF'],
    [8, 'WAVE'],
    [12, 'fmt '],
    [36, 'data'],
  ] as const)
    bytes.set(new TextEncoder().encode(value), at);
  view.setUint32(4, bytes.length - 8, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, bytes.length - 44, true);
  return new File([bytes], 'sample.wav', { type: 'audio/wav' });
}
const env = {
  AXR_CLOVA_SPEECH_INVOKE_URL:
    'https://clovaspeech-gw.ncloud.com/external/v1/123/test-domain',
  AXR_CLOVA_SPEECH_KEY: 'fixture-only',
  AXR_CLOVA_VOICE_CLIENT_ID: 'fixture-id',
  AXR_CLOVA_VOICE_CLIENT_SECRET: 'fixture-secret',
};
test('일일 호출 한도는 서비스 재생성 후에도 DB에 유지된다', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let calls = 0;
  const transport: typeof fetch = async () => {
    calls++;
    return Response.json({ text: '질문' });
  };
  const config = { ...env, AXR_EXTERNAL_DAILY_CALL_LIMIT: '1' };
  await createExternalServices(config, transport, db).transcribe(wav(), []);
  await assert.rejects(
    createExternalServices(config, transport, db).transcribe(wav(), []),
    /한도/,
  );
  assert.equal(calls, 1);
});
test('CLOVA Speech 요청: 키워드·동기 처리·오디오 외부 저장 금지', async () => {
  let count = 0;
  const api = createExternalServices(env, async (url, init) => {
    count++;
    assert.equal(
      String(url),
      env.AXR_CLOVA_SPEECH_INVOKE_URL + '/recognizer/upload',
    );
    assert.equal(
      (init!.headers as Record<string, string>)['X-CLOVASPEECH-API-KEY'],
      'fixture-only',
    );
    const media = (init!.body as FormData).get('media') as File;
    assert.equal(media.name, 'question.wav');
    assert.equal(media.type, 'audio/wav');
    const params = JSON.parse(String((init!.body as FormData).get('params')));
    assert.deepEqual(params.boostings, [
      { words: '중2 내신반' },
      { words: '개념 교재' },
    ]);
    assert.equal(params.resultToObs, false);
    assert.equal(params.completion, 'sync');
    assert.equal(init!.redirect, 'error');
    return Response.json({ text: '중2 내신반 시간표', confidence: 0.91 });
  });
  assert.deepEqual(await api.transcribe(wav(), ['중2 내신반', '개념 교재']), {
    text: '중2 내신반 시간표',
    confidence: 0.91,
  });
  assert.equal(count, 1);
});
test('음성 크기·길이·형식 검사와 일일 호출 한도', async () => {
  let count = 0;
  const api = createExternalServices(
    { ...env, AXR_EXTERNAL_DAILY_CALL_LIMIT: '1' },
    async () => {
      count++;
      return Response.json({ text: '질문', confidence: 0.8 });
    },
  );
  await assert.rejects(api.transcribe(wav(61), []));
  await assert.rejects(
    api.transcribe(new File(['bad'], 'bad.wav', { type: 'audio/wav' }), []),
  );
  assert.equal(count, 0);
  await api.transcribe(wav(), []);
  await assert.rejects(api.transcribe(wav(), []), /한도/);
  assert.equal(count, 1);
});
test('음성 엔드포인트가 공식 네이버 주소가 아니면 키를 전송하지 않는다', async () => {
  let count = 0;
  const api = createExternalServices(
    { ...env, AXR_CLOVA_SPEECH_INVOKE_URL: 'https://example.com/steal' },
    async () => {
      count++;
      return Response.json({});
    },
  );
  assert.equal(api.speechAvailable, false);
  await assert.rejects(api.transcribe(wav(), []));
  assert.equal(count, 0);
});
test('CLOVA Voice는 전달한 검증 문장만 인코딩하고 인증키를 서버 헤더로 보낸다', async () => {
  const api = createExternalServices(env, async (url, init) => {
    assert.equal(
      String(url),
      'https://naveropenapi.apigw.ntruss.com/tts-premium/v1/tts',
    );
    assert.equal(
      (init!.body as URLSearchParams).get('text'),
      '수업은 16:00입니다.',
    );
    assert.equal(
      (init!.headers as Record<string, string>)['X-NCP-APIGW-API-KEY'],
      'fixture-secret',
    );
    return new Response(new Uint8Array([73, 68, 51]), {
      headers: { 'content-type': 'audio/mpeg' },
    });
  });
  assert.equal((await api.synthesize('수업은 16:00입니다.')).length, 3);
});
test('외부 429·500·타임아웃 및 잘못된 음성 응답을 실패로 처리한다', async () => {
  for (const status of [401, 429, 500]) {
    const api = createExternalServices(
      env,
      async () => new Response('', { status }),
    );
    await assert.rejects(api.transcribe(wav(), []), /외부 서비스/);
    await assert.rejects(api.synthesize('테스트'), /외부 서비스/);
  }
  await assert.rejects(
    createExternalServices(env, async () =>
      Response.json({ error: 'unexpected' }),
    ).synthesize('테스트'),
    /음성 파일/,
  );
  await assert.rejects(
    createExternalServices(env, async () => {
      throw new Error('network');
    }).transcribe(wav(), []),
    /외부 서비스/,
  );
});
test('키가 없으면 외부 호출 없이 글 상담을 유지한다', async () => {
  let count = 0;
  const api = createExternalServices({}, async () => {
    count++;
    throw new Error();
  });
  assert.equal(api.voiceAvailable, false);
  await assert.rejects(api.transcribe(wav(), []));
  assert.equal(count, 0);
});
