import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  aliasItemIds,
  assignmentInputSchema,
  buildInstructions,
  clovaOutputSchema,
  verifyResponse,
  makeHandoff,
} from './classify.mjs';
import { compareMathReadings, transcribeImage } from './read-image.mjs';

async function save(folder, name, data) {
  await mkdir(folder, { recursive: true });
  const dest = path.join(folder, name + '.json');
  const tmp = dest + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
    await rename(tmp, dest);
  } finally {
    await rm(tmp, { force: true });
  }
}

async function run() {
  const [input, output = 'out/question-classification', repeats = '1'] =
    process.argv.slice(2);
  if (!input || !['1', '3'].includes(repeats))
    throw Error('사용법: npm run classify -- 입력.json 출력폴더 [1|3]');
  const source = assignmentInputSchema.parse(
    JSON.parse(await readFile(input, 'utf8')),
  );
  const key =
    process.env.CLOVA_STUDIO_API_KEY?.trim() ||
    process.env.RAG_CLOVA_API_KEY?.trim();
  if (!key) throw Error('.env.local에 CLOVA_STUDIO_API_KEY를 설정하세요.');
  const items = [];
  const transcriptions = [];
  const held = new Map();
  for (const item of source.items) {
    if (!item.image) {
      items.push(item);
      continue;
    }
    const { image, ...fields } = item;
    const filename = path.resolve(path.dirname(input), image);
    const result = await transcribeImage(filename);
    const check =
      source.subject === 'M'
        ? await transcribeImage(filename, { checkMath: true })
        : null;
    const reason = check ? compareMathReadings(result.text, check.text) : null;
    if (reason) held.set(item.itemId, reason);
    transcriptions.push({
      itemId: item.itemId,
      image,
      ...result,
      ...(check ? { check, holdReason: reason } : {}),
    });
    items.push({ ...fields, text: reason ? '' : result.text });
  }
  const assignment = { ...source, items };
  if (transcriptions.length) {
    await save(
      path.join(output, 'transcribed'),
      assignment.assignmentId,
      assignment,
    );
  }
  const model = process.env.CLASSIFICATION_MODEL?.trim() || 'HCX-007';
  const instructions = await buildInstructions(assignment.subject);
  const runs = [];
  const usage = [];
  const readable = {
    ...assignment,
    items: items.filter((item) => item.text.trim()),
  };
  function inAssignmentOrder(classified) {
    const byId = new Map(classified.map((item) => [item.itemId, item]));
    return items.map(
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
  for (let i = 0; readable.items.length && i < Number(repeats); i++) {
    const response = await fetch(
      'https://clovastudio.stream.ntruss.com/v3/chat-completions/' +
        encodeURIComponent(model),
      {
        method: 'POST',
        redirect: 'error',
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
      throw Error('CLOVA Studio HTTP ' + response.status + ' (' + model + ')');
    const reply = await response.json();
    const tokens = reply.result?.usage ?? null;
    usage.push(tokens);
    console.log('CLOVA token usage:', JSON.stringify(tokens));
    if (reply.result?.finishReason === 'length')
      throw Error(
        'CLOVA Studio 응답이 출력 한도에 도달했습니다. 한 번에 넣는 문항 수를 줄여 주세요.',
      );
    const content = reply.result?.message?.content;
    if (typeof content !== 'string')
      throw Error('CLOVA Studio 응답에 분류 결과가 없습니다.');
    const json = content
      .trim()
      .replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1');
    runs.push(
      inAssignmentOrder(restore(verifyResponse(aliased, JSON.parse(json)))),
    );
  }
  const classifiedAt = new Date().toISOString();
  const record = makeHandoff(assignment, runs, classifiedAt);
  await save(path.join(output, 'evidence'), assignment.assignmentId, {
    model,
    classifiedAt,
    assignment,
    runs,
    usage,
    ...(transcriptions.length ? { transcriptions } : {}),
  });
  await save(
    path.join(output, 'classification'),
    assignment.assignmentId,
    record,
  );
  console.log(
    path.join(output, 'classification', assignment.assignmentId + '.json'),
  );
}

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
