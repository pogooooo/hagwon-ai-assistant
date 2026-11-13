import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  aliasItemIds,
  annotateEvidence,
  assignmentInputSchema,
  assignmentSchema,
  buildInstructions,
  buildItemText,
  clovaOutputSchema,
  verifyResponse,
  makeHandoff,
} from './classify.mjs';
import {
  applyCrossCheck,
  crossCheckPage,
  itemsFromPhoto,
  mergeMathPage,
  readPage,
} from './read-page.mjs';

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
  // 영어 사진은 한 번 판독하고, 수학 사진은 두 번 판독해 비교한 뒤
  // 같은 오독을 줄이기 위해 사진과 전사를 직접 대조하는 교차 검수를 한 번 더 한다.
  async function readSheet(filename) {
    const first = await readPage(filename, { subject: source.subject });
    const reads = [first];
    let detected = first.items;
    if (source.subject === 'M') {
      const check = await readPage(filename, { subject: 'M', pass: 'check' });
      reads.push(check);
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
      reads: reads.map(({ model, text, usage }) => ({ model, text, usage })),
    };
  }
  for (const item of source.items) {
    if (!item.image) {
      items.push(item);
      continue;
    }
    const { image, ...fields } = item;
    const filename = path.resolve(path.dirname(input), image);
    try {
      const { detected, reads } = await readSheet(filename);
      const read = detected.length === 1 ? detected[0] : null;
      const reason = read
        ? read.holdReason
        : '사진에서 문항 ' +
          detected.length +
          '개가 감지됨 — photos 입력으로 등록하세요';
      if (reason) held.set(item.itemId, reason);
      transcriptions.push({ itemId: item.itemId, image, reads, detected });
      items.push({
        ...fields,
        text: reason ? '' : read.text,
        ...(!reason && read.figure ? { figure: read.figure } : {}),
      });
    } catch (error) {
      held.set(item.itemId, '사진 판독 실패: ' + error.message);
      transcriptions.push({ itemId: item.itemId, image, error: error.message });
      items.push({ ...fields, text: '' });
    }
  }
  for (const photo of source.photos ?? []) {
    const filename = path.resolve(path.dirname(input), photo.image);
    try {
      const { detected, reads } = await readSheet(filename);
      const generated = itemsFromPhoto(
        source.assignmentId,
        photo.page,
        detected,
      );
      for (const {
        itemId,
        page,
        displayNumber,
        text,
        figure,
        holdReason,
      } of generated) {
        if (holdReason) held.set(itemId, holdReason);
        items.push({
          itemId,
          page,
          displayNumber,
          text: holdReason ? '' : text,
          ...(!holdReason && figure ? { figure } : {}),
        });
      }
      transcriptions.push({ ...photo, reads, detected: generated });
    } catch (error) {
      transcriptions.push({ ...photo, error: error.message });
      console.error(
        '사진 판독 실패로 이 사진의 문항이 기록에서 빠졌습니다: ' +
          photo.image +
          ' — ' +
          error.message,
      );
    }
  }
  const unsaved = {
    assignmentId: source.assignmentId,
    subject: source.subject,
    items,
  };
  if (transcriptions.length) {
    await save(path.join(output, 'transcribed'), unsaved.assignmentId, unsaved);
  }
  if (!items.length)
    throw Error('사진에서 분류할 문항을 하나도 얻지 못했습니다.');
  const assignment = assignmentSchema.parse(unsaved);
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
      inAssignmentOrder(
        annotateEvidence(
          restore(verifyResponse(aliased, JSON.parse(json))),
          figures,
          builtTexts,
        ),
      ),
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
