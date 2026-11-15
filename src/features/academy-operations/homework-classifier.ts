import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  parseClassification,
  tagById,
  type Classification,
} from './classification.ts';
import { accessibleClasses } from './directory.ts';
import { classificationSubject, storeClassification } from './learning.ts';
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
import { itemsFromPhoto } from '../question-classification/read-page.mjs';

function requireTeacher(ctx: PageContext) {
  ctx.assertCurrentAccess?.();
  if (!['admin', 'teacher'].includes(ctx.actor.role))
    throw new OperationError('숙제 등록 권한이 없습니다.', 403);
}

type Subject = 'M' | 'E';
type ClassifiedItem = Classification['items'][number];
export async function analyzeHomeworkPhoto(ctx: PageContext, form: FormData) {
  requireTeacher(ctx);
  const subject = field(form, 'subject');
  if (subject !== 'M' && subject !== 'E')
    throw new OperationError('과목을 선택해 주세요.');
  if (
    !accessibleClasses(ctx.db, ctx.actor).some((c) =>
      (subject === 'M' ? /수학|math/i : /영어|english/i).test(c.subject),
    )
  )
    throw new OperationError('이 과목의 담당 반이 없습니다.', 403);
  const page = Number(field(form, 'page', 6));
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
  let texts: Map<string, string>;
  try {
    const { detected } = await readSheet({ bytes, mime }, subject);
    const items = itemsFromPhoto(pageId, page, detected).map((i) => ({
      ...i,
      text: i.holdReason ? '' : i.text,
    }));
    if (!items.length) throw Error('empty');
    texts = new Map(items.map((i) => [i.itemId, i.text]));
    const { record } = await classifyAssignment({
      assignmentId: pageId,
      subject,
      items,
    });
    classification = parseClassification(record);
  } catch {
    throw new OperationError(
      '사진을 분석하지 못했습니다. 사진과 CLOVA 연결을 확인한 뒤 다시 시도해 주세요.',
      502,
    );
  }
  return transaction(ctx.db, () => {
    requireTeacher(ctx);
    const now = Date.now();
    ctx.db
      .prepare('DELETE FROM homework_analysis_drafts WHERE expires_at <= ?')
      .run(now);
    const insert = ctx.db.prepare(
      'INSERT INTO homework_analysis_drafts (id, academy_id, teacher_id, subject, result, expires_at) VALUES (?,?,?,?,?,?)',
    );
    return classification.items.map((item) => {
      const sourceId = randomUUID();
      const text = texts.get(item.itemId) ?? '';
      insert.run(
        sourceId,
        ctx.actor.academyId,
        ctx.actor.id,
        subject,
        JSON.stringify({ item, text }),
        now + 24 * 3600000,
      );
      return {
        sourceId,
        number: item.displayNumber,
        text,
        status: item.itemStatus,
        type: item.tags
          .filter((t) => t.status === 'adopted')
          .map((t) => tagById.get(t.tagId)!.name)
          .join(', '),
      };
    });
  });
}

const draftSchema = z
  .array(
    z.object({
      book: z.string().trim().min(1).max(120),
      page: z.number().int().min(1).max(100000),
      segment: z.string().trim().max(120),
      number: z.string().trim().min(1).max(80),
      type: z.string().trim().max(500),
      sourceId: z.uuid().nullable(),
    }),
  )
  .min(1)
  .max(300);

export function saveWorkbook(ctx: PageContext, form: FormData) {
  requireTeacher(ctx);
  if (field(form, 'reviewed') !== 'yes')
    throw new OperationError('선택한 문항을 확인해 주세요.');
  const classId = required(form, 'classId', '반', 128),
    title = required(form, 'title', '숙제 제목', 120);
  const date = z.iso.date().safeParse(field(form, 'date', 10));
  if (!date.success) throw new OperationError('숙제 날짜를 확인해 주세요.');
  const id = z.uuid().safeParse(field(form, 'assignmentId', 36));
  if (!id.success)
    throw new OperationError('숙제 등록 화면을 다시 열어 주세요.');
  let raw: unknown;
  try {
    raw = JSON.parse(required(form, 'items', '출제 문항', 600000));
  } catch {
    throw new OperationError('출제 문항을 확인해 주세요.');
  }
  const input = draftSchema.safeParse(raw);
  if (!input.success)
    throw new OperationError(
      '교재·쪽·문항 번호를 입력하고 1~300문항을 선택해 주세요.',
      422,
    );
  transaction(ctx.db, () => {
    const classroom = accessibleClasses(ctx.db, ctx.actor).find(
      (c) => c.id === classId,
    );
    if (!classroom) throw new OperationError('반 관리 권한이 없습니다.', 403);
    const subject: Subject = classificationSubject(classroom.subject);
    if (field(form, 'subject') !== subject)
      throw new OperationError(
        '분석 과목과 같은 과목의 반을 선택해 주세요.',
        422,
      );
    if (one(ctx.db, 'SELECT id FROM homework_assignments WHERE id=?', id.data))
      throw new OperationError('이미 등록한 숙제입니다.', 409);
    ctx.db
      .prepare(
        "INSERT INTO homework_assignments (id,academy_id,class_id,title,due_date,submission_mode) VALUES (?,?,?,?,?,'workbook')",
      )
      .run(id.data, ctx.actor.academyId, classId, title, date.data);
    const insert = ctx.db.prepare(
      "INSERT INTO homework_questions (id,assignment_id,position,prompt,answer_key,points,problem_type,type_key) VALUES (?,?,?,?,'',1,?,?)",
    );
    const seen = new Set<string>();
    const items = input.data.map((q, index) => {
      let original: ClassifiedItem | undefined;
      let transcript = '';
      if (q.sourceId) {
        const row = one<{ result: string }>(
          ctx.db,
          'SELECT result FROM homework_analysis_drafts WHERE id=? AND academy_id=? AND teacher_id=? AND subject=? AND expires_at>?',
          q.sourceId,
          ctx.actor.academyId,
          ctx.actor.id,
          subject,
          Date.now(),
        );
        if (!row || seen.has(q.sourceId))
          throw new OperationError(
            '분석 문항이 중복되었거나 만료되었습니다. 사진을 다시 분석해 주세요.',
            422,
          );
        seen.add(q.sourceId);
        const stored = JSON.parse(row.result);
        original = stored.item;
        transcript = stored.text;
      }
      const itemId = randomUUID();
      const label = [q.book, q.page + '쪽', q.segment, q.number + '번']
        .filter(Boolean)
        .join(' · ');
      insert.run(
        itemId,
        id.data,
        index + 1,
        label,
        q.type,
        q.type.normalize('NFKC').toLowerCase(),
      );
      return {
        itemId,
        page: q.page,
        displayNumber: q.number,
        book: q.book,
        segment: q.segment,
        reviewedType: q.type,
        transcript,
        itemStatus: original?.itemStatus ?? 'no_adopted',
        tags: original?.tags ?? [],
      };
    });
    const data = parseClassification({
      formatVersion: '1.0',
      rubricVersion: '1.0',
      subject,
      assignmentId: id.data,
      classifiedAt: new Date().toISOString(),
      items,
    });
    storeClassification(ctx, data, classId, title, date.data.slice(0, 7), '0');
  });
  return '/homework?saved=' + id.data;
}
