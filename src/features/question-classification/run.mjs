import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { assignmentInputSchema, assignmentSchema } from './classify.mjs';
import { itemsFromPhoto } from './read-page.mjs';
import { classifyAssignment, readSheet } from './pipeline.mjs';

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
    try {
      const { detected, reads } = await readSheet(filename, source.subject);
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
      transcriptions.push({
        itemId: item.itemId,
        image,
        error: error.message,
        ...(error.raw ? { raw: error.raw } : {}),
      });
      items.push({ ...fields, text: '' });
    }
  }
  for (const photo of source.photos ?? []) {
    const filename = path.resolve(path.dirname(input), photo.image);
    try {
      const { detected, reads } = await readSheet(filename, source.subject);
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
      transcriptions.push({
        ...photo,
        error: error.message,
        ...(error.raw ? { raw: error.raw } : {}),
      });
      console.error(
        '사진 판독 실패로 이 사진의 문항이 기록에서 빠졌습니다: ' +
          photo.image +
          ' — ' +
          error.message +
          (error.raw ? '\n--- 판독 원문 ---\n' + error.raw : ''),
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
  const { record, model, classifiedAt, runs, usage } = await classifyAssignment(
    assignment,
    { held, repeats: Number(repeats) },
  );
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
