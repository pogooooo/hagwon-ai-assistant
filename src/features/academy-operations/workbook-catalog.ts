import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { tagById } from './classification.ts';
import { accessibleClasses, accessibleStudents } from './directory.ts';
import type { OperationsDatabase } from './database.ts';
import {
  field,
  required,
  rows,
  one,
  OperationError,
  transaction,
  type PageContext,
} from './shared.ts';

export function setupWorkbookCatalog(db: OperationsDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS books (
      id TEXT PRIMARY KEY, academy_id TEXT NOT NULL REFERENCES academies(id), subject TEXT NOT NULL CHECK(subject IN ('M','E')),
      name TEXT NOT NULL, grade TEXT NOT NULL, semester TEXT NOT NULL, edition TEXT NOT NULL,
      UNIQUE(academy_id,subject,name,grade,semester,edition)
    );
    CREATE TABLE IF NOT EXISTS book_questions (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL REFERENCES books(id), page INTEGER NOT NULL CHECK(page>0),
      number TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, UNIQUE(book_id,page,number)
    );
    CREATE TABLE IF NOT EXISTS book_question_types (
      question_id TEXT NOT NULL REFERENCES book_questions(id), tag_id TEXT NOT NULL, PRIMARY KEY(question_id,tag_id)
    );
    CREATE TABLE IF NOT EXISTS homework_workbooks (
      assignment_id TEXT PRIMARY KEY REFERENCES homework_assignments(id), book_id TEXT NOT NULL REFERENCES books(id),
      due_time TEXT, target_kind TEXT NOT NULL CHECK(target_kind IN ('class','student'))
    );
    CREATE TABLE IF NOT EXISTS homework_targets (
      assignment_id TEXT NOT NULL REFERENCES homework_workbooks(assignment_id), class_id TEXT NOT NULL REFERENCES classes(id),
      PRIMARY KEY(assignment_id,class_id)
    );
    CREATE TABLE IF NOT EXISTS homework_recipients (
      assignment_id TEXT NOT NULL, class_id TEXT NOT NULL, student_id TEXT NOT NULL REFERENCES students(id),
      PRIMARY KEY(assignment_id,class_id,student_id),
      FOREIGN KEY(assignment_id,class_id) REFERENCES homework_targets(assignment_id,class_id)
    );
    CREATE INDEX IF NOT EXISTS homework_recipient_student ON homework_recipients(student_id,assignment_id);
    CREATE TABLE IF NOT EXISTS homework_question_snapshots (
      question_id TEXT PRIMARY KEY REFERENCES homework_questions(id), book_question_id TEXT NOT NULL REFERENCES book_questions(id),
      page INTEGER NOT NULL, number TEXT NOT NULL, tag_ids TEXT NOT NULL, rubric_version TEXT NOT NULL
    );
  `);
  // 교재 문항의 정답. 처음 등록할 때 한 번 입력하고 이후 숙제에서 다시 쓴다. 비어 있으면 정답 미등록이다.
  const columns = rows<{ name: string }>(
    db,
    'PRAGMA table_info(book_questions)',
  ).map((c) => c.name);
  if (!columns.includes('answer'))
    db.exec(
      "ALTER TABLE book_questions ADD COLUMN answer TEXT NOT NULL DEFAULT ''",
    );
  if (!columns.includes('is_choice'))
    db.exec(
      'ALTER TABLE book_questions ADD COLUMN is_choice INTEGER CHECK(is_choice IN (0,1))',
    );
}

export function requireStaff(ctx: PageContext) {
  ctx.assertCurrentAccess?.();
  if (!['admin', 'teacher'].includes(ctx.actor.role))
    throw new OperationError('교사·관리자만 이용할 수 있습니다.', 403);
}
export function workbookClasses(ctx: PageContext) {
  return accessibleClasses(ctx.db, ctx.actor).flatMap((c) => {
    const math = /수학|math/i.test(c.subject),
      english = /영어|english/i.test(c.subject);
    return math === english ? [] : [{ ...c, subject: math ? 'M' : 'E' }];
  });
}
export interface Book {
  id: string;
  subject: string;
  name: string;
  grade: string;
  semester: string;
  edition: string;
}
export function booksFor(ctx: PageContext) {
  requireStaff(ctx);
  return rows<Book>(
    ctx.db,
    'SELECT * FROM books WHERE academy_id=? ORDER BY subject,name,grade,semester,edition',
    ctx.actor.academyId,
  );
}
export function bookLabel(b: Book) {
  return [b.name, b.grade, b.semester, b.edition].filter(Boolean).join(' · ');
}
export function bookQuestions(ctx: PageContext, bookId: string) {
  requireStaff(ctx);
  return rows<{
    id: string;
    page: number;
    number: string;
    version: number;
    answer: string;
    is_choice: number | null;
    tags: string;
  }>(
    ctx.db,
    `SELECT q.*,(SELECT json_group_array(tag_id ORDER BY tag_id) FROM book_question_types WHERE question_id=q.id) tags
    FROM book_questions q JOIN books b ON b.id=q.book_id WHERE b.academy_id=? AND b.id=? ORDER BY q.page,LENGTH(q.number),q.number`,
    ctx.actor.academyId,
    bookId,
  ).map((q) => ({ ...q, tagIds: JSON.parse(q.tags) as string[] }));
}

export function resolveBook(ctx: PageContext, form: FormData) {
  requireStaff(ctx);
  const subject = required(form, 'subject', '과목', 1);
  if (!workbookClasses(ctx).some((c) => c.subject === subject))
    throw new OperationError('해당 과목을 배정할 권한이 없습니다.', 403);
  const existing = field(form, 'bookId', 128);
  if (existing) {
    const book = one<Book>(
      ctx.db,
      'SELECT * FROM books WHERE academy_id=? AND id=? AND subject=?',
      ctx.actor.academyId,
      existing,
      subject,
    );
    if (!book) throw new OperationError('교재를 찾을 수 없습니다.', 404);
    return book;
  }
  const identity = [
    ctx.actor.academyId,
    subject,
    required(form, 'book', '교재 이름', 120),
    field(form, 'grade', 40),
    field(form, 'semester', 40),
    field(form, 'edition', 60),
  ];
  ctx.db
    .prepare(
      `INSERT INTO books(id,academy_id,subject,name,grade,semester,edition) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(academy_id,subject,name,grade,semester,edition) DO NOTHING`,
    )
    .run(randomUUID(), ...identity);
  return one<Book>(
    ctx.db,
    'SELECT * FROM books WHERE academy_id=? AND subject=? AND name=? AND grade=? AND semester=? AND edition=?',
    ...identity,
  )!;
}
export function registerBook(
  ctx: PageContext,
  form: FormData,
  next = '/homework?view=create',
) {
  requireStaff(ctx);
  return transaction(ctx.db, () => next + '&book=' + resolveBook(ctx, form).id);
}

/**
 * 교재 문항 하나를 공용 목록에 저장하고 유형(과 정답)을 갱신한다. 다른 강사가 그사이 유형을 고쳤으면
 * 최신 목록을 다시 불러오게 한다. 반환값은 공용 문항 id와 정렬한 유형 id다.
 */
export function saveBookQuestion(
  ctx: PageContext,
  book: Book,
  q: {
    page: number;
    number: string;
    tagIds: string[];
    version?: number | null;
    answer?: string;
    isChoice?: boolean;
  },
) {
  const ids = [...new Set(q.tagIds)].sort();
  if (
    ids.length !== q.tagIds.length ||
    ids.some((t) => tagById.get(t)?.subject !== book.subject)
  )
    throw new OperationError('중복 문항 또는 과목과 다른 유형이 있습니다.');
  const prior = one<{
    id: string;
    version: number;
    answer: string;
    is_choice: number | null;
  }>(
    ctx.db,
    'SELECT id,version,answer,is_choice FROM book_questions WHERE book_id=? AND page=? AND number=?',
    book.id,
    q.page,
    q.number,
  );
  const master = prior?.id ?? randomUUID();
  const choice = q.isChoice === undefined ? null : Number(q.isChoice);
  if (!prior)
    ctx.db
      .prepare(
        'INSERT INTO book_questions(id,book_id,page,number,answer,is_choice) VALUES(?,?,?,?,?,?)',
      )
      .run(master, book.id, q.page, q.number, q.answer ?? '', choice);
  const previous = rows<{ tag_id: string }>(
    ctx.db,
    'SELECT tag_id FROM book_question_types WHERE question_id=? ORDER BY tag_id',
    master,
  ).map((t) => t.tag_id);
  const answerChanged =
    !!prior &&
    q.answer !== undefined &&
    (q.answer !== prior.answer || choice !== prior.is_choice);
  const typesChanged = JSON.stringify(previous) !== JSON.stringify(ids);
  if (prior && (typesChanged || answerChanged) && q.version !== prior.version)
    throw new OperationError(
      '교재 목록에서 해당 문항의 최신 유형·정답을 불러온 뒤 수정해 주세요.',
      409,
    );
  if (typesChanged) {
    ctx.db
      .prepare('DELETE FROM book_question_types WHERE question_id=?')
      .run(master);
    for (const tag of ids)
      ctx.db
        .prepare(
          'INSERT INTO book_question_types(question_id,tag_id) VALUES(?,?)',
        )
        .run(master, tag);
  }
  if (answerChanged)
    ctx.db
      .prepare('UPDATE book_questions SET answer=?,is_choice=? WHERE id=?')
      .run(q.answer ?? '', choice, master);
  if (prior && (typesChanged || answerChanged))
    ctx.db
      .prepare('UPDATE book_questions SET version=version+1 WHERE id=?')
      .run(master);
  return { master, ids };
}

const itemSchema = z
  .array(
    z.object({
      page: z.number().int().min(1).max(100000),
      number: z.string().trim().min(1).max(80),
      tagIds: z.array(z.string()).max(25),
      version: z.number().int().positive().nullable().optional(),
    }),
  )
  .min(1)
  .max(300);

export function assignWorkbook(ctx: PageContext, form: FormData) {
  requireStaff(ctx);
  let input: unknown;
  try {
    input = JSON.parse(required(form, 'items', '문항', 600000));
  } catch {
    throw new OperationError('문항 목록을 확인해 주세요.');
  }
  const parsed = itemSchema.safeParse(input),
    id = z.uuid().safeParse(field(form, 'assignmentId', 36)),
    date = z.iso.date().safeParse(field(form, 'date', 10));
  const time = field(form, 'time', 5),
    title = required(form, 'title', '숙제 이름', 120);
  if (
    !parsed.success ||
    !id.success ||
    !date.success ||
    (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
  )
    throw new OperationError('문항·마감일·시간을 확인해 주세요.');
  const kind = field(form, 'targetKind');
  if (kind !== 'class' && kind !== 'student')
    throw new OperationError('배정 대상을 선택해 주세요.');
  return transaction(ctx.db, () => {
    const book = resolveBook(ctx, form);
    const classes = workbookClasses(ctx).filter(
      (c) => c.subject === book.subject,
    );
    const selected = new Set(
      form.getAll(kind === 'class' ? 'classId' : 'recipient').map(String),
    );
    if (!selected.size) throw new OperationError('배정 대상을 선택해 주세요.');
    const targets = new Map<string, Set<string>>();
    const students = accessibleStudents(ctx.db, ctx.actor);
    for (const target of selected) {
      const [classId, studentId] =
        kind === 'class' ? [target, undefined] : target.split('|');
      if (!classes.some((c) => c.id === classId))
        throw new OperationError('담당 반을 확인해 주세요.', 403);
      const members = students.filter((s) => s.classIds.includes(classId));
      const recipients = studentId
        ? members.filter((s) => s.id === studentId)
        : members;
      if (
        kind === 'student' &&
        (!studentId ||
          target !== classId + '|' + studentId ||
          !recipients.length)
      )
        throw new OperationError('개별 배정 학생을 확인해 주세요.', 403);
      const group = targets.get(classId) ?? new Set<string>();
      for (const s of recipients) group.add(s.id);
      targets.set(classId, group);
    }
    if (one(ctx.db, 'SELECT id FROM homework_assignments WHERE id=?', id.data))
      throw new OperationError('이미 등록된 숙제입니다.', 409);
    // Existing databases require a class_id. Visibility uses targets and recipients.
    ctx.db
      .prepare(
        `INSERT INTO homework_assignments(id,academy_id,class_id,title,due_date,submission_mode)
      VALUES(?,?,?,?,?,'catalog')`,
      )
      .run(
        id.data,
        ctx.actor.academyId,
        [...targets.keys()][0],
        title,
        date.data,
      );
    ctx.db
      .prepare(
        'INSERT INTO homework_workbooks(assignment_id,book_id,due_time,target_kind) VALUES(?,?,?,?)',
      )
      .run(id.data, book.id, time || null, kind);
    for (const [classId, members] of targets) {
      ctx.db
        .prepare(
          'INSERT INTO homework_targets(assignment_id,class_id) VALUES(?,?)',
        )
        .run(id.data, classId);
      for (const student of members)
        ctx.db
          .prepare(
            'INSERT INTO homework_recipients(assignment_id,class_id,student_id) VALUES(?,?,?)',
          )
          .run(id.data, classId, student);
    }
    const seen = new Set<string>();
    for (const [index, q] of parsed.data.entries()) {
      const key = JSON.stringify([q.page, q.number]);
      if (seen.has(key))
        throw new OperationError('중복 문항 또는 과목과 다른 유형이 있습니다.');
      seen.add(key);
      const { master, ids } = saveBookQuestion(ctx, book, q);
      const question = randomUUID(),
        types = ids.map((t) => tagById.get(t)!.name).join(', ');
      ctx.db
        .prepare(
          `INSERT INTO homework_questions(id,assignment_id,position,prompt,answer_key,points,problem_type,type_key) VALUES(?,?,?,?,'',1,?,?)`,
        )
        .run(
          question,
          id.data,
          index + 1,
          book.name + ' · ' + q.page + '쪽 · ' + q.number + '번',
          types,
          ids.join(','),
        );
      ctx.db
        .prepare(
          `INSERT INTO homework_question_snapshots(question_id,book_question_id,page,number,tag_ids,rubric_version) VALUES(?,?,?,?,?,'1.0')`,
        )
        .run(question, master, q.page, q.number, JSON.stringify(ids));
    }
    return '/homework?detail=' + id.data;
  });
}
