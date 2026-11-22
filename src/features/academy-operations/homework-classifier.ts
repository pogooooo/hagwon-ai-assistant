import { randomUUID } from 'node:crypto';
import {
  parseClassification,
  tagById,
  type Classification,
} from './classification.ts';
import { accessibleClasses } from './directory.ts';
import {
  OperationError,
  required,
  field,
  one,
  transaction,
  type PageContext,
} from './shared.ts';
import {
  readSheet,
  classifyAssignment,
} from '../question-classification/pipeline.mjs';
import {
  itemsFromPhoto,
  pagesFromReadings,
} from '../question-classification/read-page.mjs';
import {
  ocrConfigured,
  readSheetService,
} from '../question-classification/ocr-page.mjs';
import { suggestArea } from '../question-classification/area-suggest.mjs';

function requireTeacher(ctx: PageContext) {
  ctx.assertCurrentAccess?.();
  if (!['admin', 'teacher'].includes(ctx.actor.role))
    throw new OperationError('숙제 등록 권한이 없습니다.', 403);
}

type Subject = 'M' | 'E';
type ClassifiedItem = Classification['items'][number];
type Review = { reason: string; candidates: string[] };
interface ReadingDraft {
  item: ClassifiedItem;
  text: string;
  printedPage?: number;
  review?: Review;
  figure?: unknown;
  /** 대분류 추천(수학·영어). 화면에서 대분류를 미리 골라 둔다. */
  area?: string;
}

// 대분류를 따로 추천하고, 기존 분류의 소분류 태그 중 그 대분류에 속한 것만 남긴다.
// 추천에 실패하면(호출 오류) 기존 분류 결과를 그대로 쓴다. 문항 원문은 예시로 저장하지 않는다.
async function suggestAreas(subject: Subject, texts: Map<string, string>) {
  const areas = new Map<string, string>();
  for (const [itemId, text] of texts) {
    if (!text.trim()) continue;
    const area = await suggestArea(subject, text).catch(() => null);
    if (area) areas.set(itemId, area);
  }
  return areas;
}
function withArea(item: ClassifiedItem, area: string | undefined) {
  if (!area) return item;
  const tags = item.tags.filter((t) => tagById.get(t.tagId)?.area === area);
  const itemStatus =
    item.itemStatus === 'classified' &&
    !tags.some((t) => t.status === 'adopted')
      ? 'no_adopted'
      : item.itemStatus;
  return { ...item, tags, itemStatus };
}

function requireSubject(
  ctx: PageContext,
  subject: string,
): asserts subject is Subject {
  requireTeacher(ctx);
  if (subject !== 'M' && subject !== 'E')
    throw new OperationError('과목을 선택해 주세요.');
  if (
    !accessibleClasses(ctx.db, ctx.actor).some((c) =>
      (subject === 'M' ? /수학|math/i : /영어|english/i).test(c.subject),
    )
  )
    throw new OperationError('이 과목의 담당 반이 없습니다.', 403);
}

function storeDraft(
  ctx: PageContext,
  subject: Subject,
  draft: ReadingDraft,
  expiresAt: number,
) {
  const sourceId = randomUUID();
  ctx.db
    .prepare(
      'INSERT INTO homework_analysis_drafts (id, academy_id, teacher_id, subject, result, expires_at) VALUES (?,?,?,?,?,?)',
    )
    .run(
      sourceId,
      ctx.actor.academyId,
      ctx.actor.id,
      subject,
      JSON.stringify(draft),
      expiresAt,
    );
  return {
    sourceId,
    number: draft.item.displayNumber,
    page: draft.printedPage,
    tagIds: draft.item.tags
      .filter((t) => t.status === 'adopted')
      .map((t) => t.tagId),
    text: draft.text,
    status: draft.item.itemStatus,
    review: draft.review,
    area:
      draft.area ??
      tagById.get(
        draft.item.tags.find((t) => t.status === 'adopted')?.tagId ?? '',
      )?.area,
    type: draft.item.tags
      .filter((t) => t.status === 'adopted')
      .map((t) => tagById.get(t.tagId)!.name)
      .join(', '),
  };
}

function loadDraft(ctx: PageContext, subject: Subject, sourceId: string) {
  const row = one<{ result: string; expires_at: number }>(
    ctx.db,
    'SELECT result, expires_at FROM homework_analysis_drafts WHERE id=? AND academy_id=? AND teacher_id=? AND subject=? AND expires_at>?',
    sourceId,
    ctx.actor.academyId,
    ctx.actor.id,
    subject,
    Date.now(),
  );
  if (!row)
    throw new OperationError(
      '분석 문항이 만료되었거나 접근할 수 없습니다. 사진을 다시 분석해 주세요.',
      422,
    );
  return {
    draft: JSON.parse(row.result) as ReadingDraft,
    expiresAt: row.expires_at,
  };
}

export async function analyzeHomeworkPhoto(ctx: PageContext, form: FormData) {
  const subject = field(form, 'subject');
  requireSubject(ctx, subject);
  const manualPage = field(form, 'page', 6);
  const page = Number(manualPage || 1);
  if (!Number.isInteger(page) || page < 1 || page > 100000)
    throw new OperationError('쪽수를 확인해 주세요.');
  const file = form.get('photo');
  if (!(file instanceof File) || !file.size)
    throw new OperationError('문제 사진을 선택해 주세요.');
  if (file.size > 5 * 1024 * 1024)
    throw new OperationError('사진은 5MB 이하로 올려 주세요.', 413);
  const bytes = Buffer.from(await file.arrayBuffer());
  const mime = bytes
    .subarray(0, 8)
    .equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    ? 'image/png'
    : bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
      ? 'image/jpeg'
      : '';
  if (!mime) throw new OperationError('PNG 또는 JPEG 사진을 올려 주세요.', 415);
  if (!(
    process.env.CLOVA_STUDIO_API_KEY?.trim() ||
    process.env.RAG_CLOVA_API_KEY?.trim()
  ))
    throw new OperationError('서버에 CLOVA API 키를 설정해 주세요.', 503);
  const pageId = randomUUID();
  let classification: Classification;
  let areas = new Map<string, string>();
  const readings = new Map<string, Omit<ReadingDraft, 'item'>>();
  try {
    // CLOVA OCR이 설정되어 있으면 OCR로 문항을 나누고(수학은 문항을 잘라 다시 판독), 아니면 기존 판독을 쓴다.
    const { detected, readingPasses } = ocrConfigured()
      ? await readSheetService({ bytes, mime }, subject)
      : await readSheet({ bytes, mime }, subject);
    const items = itemsFromPhoto(pageId, page, detected).map((i) => ({
      ...i,
      text: i.holdReason ? '' : i.text,
    }));
    if (!items.length) throw Error('사진에서 문항 번호를 찾지 못했습니다.');
    for (const i of items) {
      const candidates = [
        ...new Set<string>(
          readingPasses
            .flat()
            .filter(
              (reading: { displayNumber: string }) =>
                reading.displayNumber === i.displayNumber,
            )
            .map((reading: { text: string }) => reading.text.trim())
            .filter(Boolean),
        ),
      ];
      readings.set(i.itemId, {
        printedPage: manualPage
          ? page
          : pagesFromReadings(
              readingPasses.map((pass: { displayNumber: string }[]) =>
                pass.filter((r) => r.displayNumber === i.displayNumber),
              ),
            ),
        text: i.text,
        figure: i.figure,
        review:
          i.holdReason || !i.text.trim()
            ? {
                reason: i.holdReason || '판독된 원문이 비어 있습니다.',
                candidates,
              }
            : undefined,
      });
    }
    const { record } = await classifyAssignment({
      assignmentId: pageId,
      subject,
      items,
    });
    classification = parseClassification(record);
    areas = await suggestAreas(
      subject,
      new Map(items.map((i) => [i.itemId, i.text])),
    );
  } catch (error) {
    // 화면에는 일반 안내만 보이므로 실제 원인(OCR HTTP 오류, 문항 0개 등)은 서버 로그에 남긴다.
    console.error(
      '[homework-photo] 분석 실패:',
      error instanceof Error ? error.message : error,
    );
    throw new OperationError(
      '사진을 분석하지 못했습니다. 사진과 CLOVA 연결을 확인한 뒤 다시 시도해 주세요.',
      502,
    );
  }
  return transaction(ctx.db, () => {
    requireSubject(ctx, subject);
    const now = Date.now();
    ctx.db
      .prepare('DELETE FROM homework_analysis_drafts WHERE expires_at <= ?')
      .run(now);
    return classification.items.map((item) => {
      const reading = readings.get(item.itemId)!;
      if (!reading.review && item.itemStatus === 'unreadable')
        reading.review = {
          reason: '분류 모델이 원문을 읽기 불가로 판단했습니다.',
          candidates: [reading.text],
        };
      const area = areas.get(item.itemId);
      return storeDraft(
        ctx,
        subject,
        { item: withArea(item, area), ...reading, area },
        now + 24 * 3600000,
      );
    });
  });
}

export async function reviewHomeworkReading(ctx: PageContext, form: FormData) {
  const subject = field(form, 'subject');
  requireSubject(ctx, subject);
  const sourceId = required(form, 'sourceId', '문항', 36);
  const text = required(form, 'text', '확인한 원문', 60000);
  if (text.includes('[불명]'))
    throw new OperationError('[불명] 표시를 사진에서 확인해 수정해 주세요.');
  const { draft, expiresAt } = loadDraft(ctx, subject, sourceId);
  if (!draft.review) throw new OperationError('판독 검수 대상이 아닙니다.');
  let item: ClassifiedItem;
  let area: string | undefined;
  try {
    const { record } = await classifyAssignment({
      assignmentId: sourceId,
      subject,
      items: [{ ...draft.item, text, figure: draft.figure }],
    });
    [item] = parseClassification(record).items;
    area = (await suggestAreas(subject, new Map([[item.itemId, text]]))).get(
      item.itemId,
    );
  } catch {
    throw new OperationError(
      '원문을 분류하지 못했습니다. 잠시 후 다시 시도해 주세요.',
      502,
    );
  }
  if (item.itemStatus === 'unreadable')
    throw new OperationError(
      '수정한 원문도 읽기 불가로 분류됐습니다. 식과 공통 조건을 확인해 주세요.',
      422,
    );
  requireSubject(ctx, subject);
  loadDraft(ctx, subject, sourceId);
  return storeDraft(
    ctx,
    subject,
    { item: withArea(item, area), text, area },
    expiresAt,
  );
}
