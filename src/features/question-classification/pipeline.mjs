import {
  aliasItemIds,
  annotateEvidence,
  buildInstructions,
  buildItemText,
  clovaOutputSchema,
  verifyResponse,
  makeHandoff,
} from './classify.mjs';
import {
  applyCrossCheck,
  crossCheckPage,
  mergeMathPage,
  readPage,
} from './read-page.mjs';

// 영어 사진은 한 번 판독하고, 수학 사진은 두 번 판독해 비교한 뒤
// 같은 오독을 줄이기 위해 사진과 전사를 직접 대조하는 교차 검수를 한 번 더 한다.
export async function readSheet(filename, subject) {
  const first = await readPage(filename, { subject: subject });
  const reads = [first];
  const readingPasses = [first.items];
  let detected = first.items;
  if (subject === 'M') {
    const check = await readPage(filename, { subject: 'M', pass: 'check' });
    reads.push(check);
    readingPasses.push(check.items);
    detected = mergeMathPage(first.items, check.items);
    const sound = detected.filter((m) => !m.holdReason && m.text.trim());
    if (sound.length) {
      const cross = await crossCheckPage(filename, sound);
      reads.push(cross);
      detected = applyCrossCheck(detected, cross.verdicts);
    }
  }
  return {
    detected,
    readingPasses,
    reads: reads.map(({ model, text, usage }) => ({ model, text, usage })),
  };
}

export async function classifyAssignment(
  assignment,
  { held = new Map(), repeats = 1 } = {},
) {
  const key =
    process.env.CLOVA_STUDIO_API_KEY?.trim() ||
    process.env.RAG_CLOVA_API_KEY?.trim();
  if (!key) throw Error('.env.local에 CLOVA_STUDIO_API_KEY를 설정하세요.');
  const model = process.env.CLASSIFICATION_MODEL?.trim() || 'HCX-007';
  // 그림 정보는 [그림N] 줄로 원문 뒤에 붙여 보내고, 각 줄의 위치로 인용 근거를 가른다.
  const builtTexts = new Map();
  const figures = new Map();
  for (const item of assignment.items) {
    const built = buildItemText(item.text, item.figure);
    builtTexts.set(item.itemId, built.text);
    if (built.figureSpans.length) figures.set(item.itemId, built);
  }
  const instructions = await buildInstructions(assignment.subject, {
    withFigures: figures.size > 0,
  });
  const runs = [];
  const usage = [];
  const readable = {
    ...assignment,
    items: assignment.items
      .filter((item) => item.text.trim())
      .map((item) => ({ ...item, text: builtTexts.get(item.itemId) })),
  };
  function inAssignmentOrder(classified) {
    const byId = new Map(classified.map((item) => [item.itemId, item]));
    return assignment.items.map(
      ({ itemId }) =>
        byId.get(itemId) ?? {
          itemId,
          disposition: 'unreadable',
          reasoning: held.get(itemId) ?? '빈 원문',
          tags: [],
        },
    );
  }
  const { aliased, restore } = aliasItemIds(readable);
  if (!readable.items.length) runs.push(inAssignmentOrder([]));
  // 응답이 형식 검증을 통과하지 못하면(빈 reasoning, 문항 수 불일치, 깨진 JSON) 사진 전체가
  // 실패하므로 그 경우에만 같은 요청을 한 번 더 보낸다. HTTP 오류와 출력 한도 초과는 재시도하지 않는다.
  let retries = 0;
  for (let i = 0; readable.items.length && i < Number(repeats); i++) {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(
        'https://clovastudio.stream.ntruss.com/v3/chat-completions/' +
          encodeURIComponent(model),
        {
          method: 'POST',
          redirect: 'manual',
          signal: AbortSignal.timeout(120000),
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + key,
          },
          body: JSON.stringify({
            ...(model === 'HCX-007'
              ? {
                  maxCompletionTokens: 4096,
                  thinking: { effort: 'none' },
                  responseFormat: {
                    type: 'json',
                    schema: clovaOutputSchema(assignment.subject),
                  },
                }
              : { maxTokens: 4096 }),
            messages: [
              { role: 'system', content: instructions },
              {
                role: 'user',
                content: JSON.stringify(
                  aliased.items.map(({ itemId, text }) => ({ itemId, text })),
                ),
              },
            ],
          }),
        },
      );
      if (!response.ok)
        throw Error(
          'CLOVA Studio HTTP ' + response.status + ' (' + model + ')',
        );
      const reply = await response.json();
      const tokens = reply.result?.usage ?? null;
      usage.push(tokens);
      console.log('CLOVA token usage:', JSON.stringify(tokens));
      if (reply.result?.finishReason === 'length')
        throw Error(
          'CLOVA Studio 응답이 출력 한도에 도달했습니다. 한 번에 넣는 문항 수를 줄여 주세요.',
        );
      const content = reply.result?.message?.content;
      try {
        if (typeof content !== 'string')
          throw Error('CLOVA Studio 응답에 분류 결과가 없습니다.');
        const json = content
          .trim()
          .replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1');
        runs.push(
          inAssignmentOrder(
            annotateEvidence(
              restore(
                verifyResponse(aliased, JSON.parse(json), {
                  lenient: attempt >= 1,
                }),
              ),
              figures,
              builtTexts,
            ),
          ),
        );
        break;
      } catch (error) {
        if (attempt >= 1) throw error;
        retries += 1;
        console.log(
          'CLOVA 분류 응답 검증 실패, 한 번 더 요청:',
          error.message.slice(0, 200),
        );
      }
    }
  }
  const classifiedAt = new Date().toISOString();
  const record = makeHandoff(assignment, runs, classifiedAt);
  return { record, model, classifiedAt, runs, usage, retries };
}
