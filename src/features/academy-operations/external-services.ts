import { createNeisClient } from './neis.ts';
import { OperationError } from './shared.ts';
import type { OperationsDatabase } from './database.ts';

export type ExternalEnv = Record<string, string | undefined>;
export interface ExternalServices {
  neis: ReturnType<typeof createNeisClient>;
  speechAvailable: boolean;
  voiceAvailable: boolean;
  transcribe(
    file: File,
    keywords: string[],
  ): Promise<{ text: string; confidence: number | null }>;
  synthesize(text: string): Promise<Uint8Array>;
}
/** Short calls, no audio storage, no background retries or unbounded model use. */
export function createExternalServices(
  env: ExternalEnv = {},
  fetchImpl: typeof fetch = fetch,
  db?: OperationsDatabase,
): ExternalServices {
  db?.exec(
    'CREATE TABLE IF NOT EXISTS op_external_usage(day TEXT NOT NULL,kind TEXT NOT NULL,calls INTEGER NOT NULL,PRIMARY KEY(day,kind))',
  );
  const counters = new Map<string, { day: string; count: number }>();
  function budget(kind: string, maximum: number) {
    const day = new Date().toISOString().slice(0, 10);
    if (db) {
      if (
        maximum === 0 ||
        !db
          .prepare(
            'INSERT INTO op_external_usage(day,kind,calls) VALUES(?,?,1) ON CONFLICT(day,kind) DO UPDATE SET calls=calls+1 WHERE calls<?',
          )
          .run(day, kind, maximum).changes
      )
        throw new OperationError(
          '오늘 외부 서비스 사용 한도에 도달했습니다. 글로 상담해 주세요.',
          429,
        );
      return;
    }
    const counter = counters.get(kind);
    const count = counter?.day === day ? counter.count : 0;
    if (count >= maximum)
      throw new OperationError(
        '오늘 외부 서비스 사용 한도에 도달했습니다. 글로 상담해 주세요.',
        429,
      );
    counters.set(kind, { day, count: count + 1 });
  }
  async function post(url: string, init: RequestInit) {
    try {
      const response = await fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(25000),
        redirect: 'error',
      });
      if (!response.ok) throw new Error();
      return response;
    } catch {
      throw new OperationError(
        '외부 서비스 응답이 없습니다. 글로 입력하거나 잠시 후 다시 시도해 주세요.',
        503,
      );
    }
  }
  const limit = Number(env.AXR_EXTERNAL_DAILY_CALL_LIMIT ?? '100');
  const maximum =
    Number.isInteger(limit) && limit >= 0 && limit <= 1000 ? limit : 100;
  const speechUrl = env.AXR_CLOVA_SPEECH_INVOKE_URL?.replace(/\/$/, '') ?? '';
  const speechAvailable =
    /^https:\/\/clovaspeech-gw\.ncloud\.com\/external\/v1\/\d+\/[a-zA-Z0-9_-]+$/.test(
      speechUrl,
    ) && Boolean(env.AXR_CLOVA_SPEECH_KEY);
  const voiceAvailable = Boolean(
    env.AXR_CLOVA_VOICE_CLIENT_ID && env.AXR_CLOVA_VOICE_CLIENT_SECRET,
  );
  return {
    neis: createNeisClient(env.AXR_NEIS_API_KEY, fetchImpl),
    speechAvailable,
    voiceAvailable,
    async transcribe(file, keywords) {
      if (!speechAvailable)
        throw new OperationError(
          '음성 인식 연결 전입니다. 글로 입력해 주세요.',
          503,
        );
      if (file.size > 2_000_000 || file.size < 44 || file.type !== 'audio/wav')
        throw new OperationError('60초 이내 WAV 녹음을 사용해 주세요.', 413);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const header = new DataView(bytes.buffer);
      if (
        new TextDecoder().decode(bytes.slice(0, 4)) !== 'RIFF' ||
        new TextDecoder().decode(bytes.slice(8, 12)) !== 'WAVE' ||
        new TextDecoder().decode(bytes.slice(12, 16)) !== 'fmt ' ||
        new TextDecoder().decode(bytes.slice(36, 40)) !== 'data' ||
        header.getUint32(4, true) + 8 !== bytes.length ||
        header.getUint32(16, true) !== 16 ||
        header.getUint16(20, true) !== 1 ||
        header.getUint16(22, true) !== 1 ||
        header.getUint32(24, true) !== 16000 ||
        header.getUint32(28, true) !== 32000 ||
        header.getUint16(32, true) !== 2 ||
        header.getUint16(34, true) !== 16 ||
        header.getUint32(40, true) > 16000 * 2 * 60 ||
        header.getUint32(40, true) + 44 !== bytes.length
      )
        throw new OperationError('16kHz 모노 PCM WAV 녹음이 필요합니다.');
      budget('speech', maximum);
      const body = new FormData();
      body.set('media', file, 'question.wav');
      body.set(
        'params',
        JSON.stringify({
          language: 'ko-KR',
          completion: 'sync',
          fullText: true,
          wordAlignment: false,
          diarization: { enable: false },
          sed: { enable: false },
          resultToObs: false,
          boostings: keywords.slice(0, 100).map((words) => ({ words })),
        }),
      );
      const data = (await (
        await post(speechUrl + '/recognizer/upload', {
          method: 'POST',
          headers: { 'X-CLOVASPEECH-API-KEY': env.AXR_CLOVA_SPEECH_KEY! },
          body,
        })
      ).json()) as { text?: unknown; confidence?: unknown; result?: string };
      if (
        typeof data.text !== 'string' ||
        !data.text.trim() ||
        data.text.length > 500
      )
        throw new OperationError(
          '질문을 인식하지 못했습니다. 다시 말하거나 글로 입력해 주세요.',
          422,
        );
      return {
        text: data.text.trim(),
        confidence:
          typeof data.confidence === 'number' &&
          Number.isFinite(data.confidence) &&
          data.confidence >= 0 &&
          data.confidence <= 1
            ? data.confidence
            : null,
      };
    },
    async synthesize(text) {
      if (!voiceAvailable)
        throw new OperationError(
          '음성 합성 연결 전입니다. 글 답변을 확인해 주세요.',
          503,
        );
      if (!text || text.length > 2000)
        throw new OperationError('음성 안내 길이를 확인해 주세요.');
      budget('voice', maximum);
      const response = await post(
        'https://naveropenapi.apigw.ntruss.com/tts-premium/v1/tts',
        {
          method: 'POST',
          headers: {
            'X-NCP-APIGW-API-KEY-ID': env.AXR_CLOVA_VOICE_CLIENT_ID!,
            'X-NCP-APIGW-API-KEY': env.AXR_CLOVA_VOICE_CLIENT_SECRET!,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            speaker: 'nara',
            text,
            volume: '0',
            speed: '0',
            pitch: '0',
            format: 'mp3',
          }),
        },
      );
      if (!response.headers.get('content-type')?.startsWith('audio/'))
        throw new OperationError('음성 파일을 받지 못했습니다.', 503);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > 5_000_000)
        throw new OperationError('음성 응답 크기를 확인해 주세요.', 503);
      return bytes;
    },
  };
}
