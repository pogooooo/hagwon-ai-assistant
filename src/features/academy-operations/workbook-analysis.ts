import { createHash } from 'node:crypto';
import { z } from 'zod';
import { tagById, tagCatalog, type Tag } from './classification.ts';
import type { OperationsDatabase } from './database.ts';
import { rows } from './shared.ts';

export interface WorkbookAnalysisResult {
  submissionId: string;
  assignmentId: string;
  title: string;
  studentId: string;
  studentName: string;
  classes: { id: string; name: string }[];
  bookId: string;
  bookLabel: string;
  subject: 'M' | 'E';
  dueDate: string;
  reviewVersion: number;
  reviewedAt: string;
  questions: {
    id: string;
    bookQuestionId: string;
    page: number;
    number: string;
    correct: number;
    tags: Tag[];
  }[];
}

const reviewedScores = z.array(
  z.object({
    questionId: z.string(),
    points: z.union([z.literal(0), z.literal(1)]),
  }),
);
const snapshot = z.object({
  book_question_id: z.string().min(1),
  page: z.number().int().positive(),
  number: z.string().min(1),
  tag_ids: z.string(),
  rubric_version: z.literal('1.0'),
});
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Read-only adapter for the team's catalog schema. No legacy auto-confirmed
 * workbook records or unreviewed submissions are treated as teacher approval. */
export function readWorkbookAnalysis(
  db: OperationsDatabase,
  academyId: string,
) {
  const results: WorkbookAnalysisResult[] = [];
  const rejected: string[] = [];
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='homework_workbooks'",
      )
      .get()
  )
    return { results, rejected };
  const submissions = rows<{
    id: string;
    assignment_id: string;
    title: string;
    student_id: string;
    student_name: string;
    book_id: string;
    book_name: string;
    grade: string;
    semester: string;
    edition: string;
    subject: 'M' | 'E';
    due_date: string;
    review_version: number;
    confirmed_at: string;
    scores: string | null;
    finalized_at: string | null;
  }>(
    db,
    `SELECT s.*, a.title,a.due_date,b.id book_id,b.name book_name,b.grade,b.semester,b.edition,b.subject,
    st.name student_name,g.scores,g.finalized_at
    FROM homework_submissions s JOIN homework_assignments a ON a.id=s.assignment_id
    JOIN homework_workbooks w ON w.assignment_id=a.id
    JOIN books b ON b.id=w.book_id AND b.academy_id=a.academy_id
    JOIN students st ON st.id=s.student_id AND st.academy_id=a.academy_id
    LEFT JOIN homework_grade_revisions g ON g.submission_id=s.id AND g.version=s.review_version
    WHERE a.academy_id=? AND a.submission_mode='catalog' AND s.confirmed_at IS NOT NULL
    ORDER BY a.due_date,a.id,s.id`,
    academyId,
  );
  for (const s of submissions) {
    const classes = rows<{ id: string; name: string }>(
      db,
      `SELECT c.id,c.name FROM homework_recipients r
      JOIN homework_targets t ON t.assignment_id=r.assignment_id AND t.class_id=r.class_id
      JOIN classes c ON c.id=t.class_id AND c.academy_id=?
      WHERE r.assignment_id=? AND r.student_id=? ORDER BY c.id`,
      academyId,
      s.assignment_id,
      s.student_id,
    );
    const questions = rows<{
      id: string;
      book_question_id: string | null;
      page: number | null;
      number: string | null;
      tag_ids: string | null;
      rubric_version: string | null;
      awarded_points: number | null;
    }>(
      db,
      `SELECT q.id,p.book_question_id,p.page,p.number,p.tag_ids,p.rubric_version,m.awarded_points
      FROM homework_questions q
      LEFT JOIN homework_question_snapshots p ON p.question_id=q.id
      LEFT JOIN book_questions bq ON bq.id=p.book_question_id AND bq.book_id=?
      LEFT JOIN homework_marks m ON m.question_id=q.id AND m.submission_id=?
      WHERE q.assignment_id=? AND (p.question_id IS NULL OR bq.id IS NOT NULL) ORDER BY q.position`,
      s.book_id,
      s.id,
      s.assignment_id,
    );
    try {
      const scores = reviewedScores.parse(JSON.parse(s.scores ?? 'null'));
      const scoreMap = new Map(scores.map((q) => [q.questionId, q.points]));
      const count = Number(
        db
          .prepare(
            'SELECT count(*) n FROM homework_questions WHERE assignment_id=?',
          )
          .get(s.assignment_id)?.n,
      );
      const markCount = Number(
        db
          .prepare(
            'SELECT count(*) n FROM homework_marks WHERE submission_id=?',
          )
          .get(s.id)?.n,
      );
      if (
        !classes.length ||
        !count ||
        count !== questions.length ||
        markCount !== count ||
        scores.length !== count ||
        scoreMap.size !== count ||
        s.review_version < 1 ||
        s.confirmed_at !== s.finalized_at ||
        !Number.isFinite(Date.parse(s.confirmed_at)) ||
        !z.iso.date().safeParse(s.due_date).success
      )
        throw Error('incomplete review');
      const parsed = questions.map((q) => {
        const p = snapshot.parse(q);
        const ids = z.array(z.string()).parse(JSON.parse(p.tag_ids));
        if (
          p.rubric_version !== tagCatalog.rubricVersion ||
          new Set(ids).size !== ids.length ||
          ids.some((id) => tagById.get(id)?.subject !== s.subject) ||
          !scoreMap.has(q.id) ||
          scoreMap.get(q.id) !== q.awarded_points
        )
          throw Error('snapshot or scores changed without review');
        return {
          id: q.id,
          bookQuestionId: p.book_question_id,
          page: p.page,
          number: p.number,
          correct: scoreMap.get(q.id)!,
          tags: ids.sort().map((id) => tagById.get(id)!),
        };
      });
      results.push({
        submissionId: s.id,
        assignmentId: s.assignment_id,
        title: s.title,
        studentId: s.student_id,
        studentName: s.student_name,
        classes,
        bookId: s.book_id,
        bookLabel: [s.book_name, s.grade, s.semester, s.edition]
          .filter(Boolean)
          .join(' · '),
        subject: s.subject,
        dueDate: s.due_date,
        reviewVersion: s.review_version,
        reviewedAt: s.confirmed_at,
        questions: parsed,
      });
    } catch {
      // A partial/corrupt review must never become a smaller, deceptively complete report.
      rejected.push(s.id);
    }
  }
  return { results, rejected };
}

export function workbookFingerprint(
  results: readonly WorkbookAnalysisResult[],
) {
  return digest(
    [...results].sort((a, b) => a.submissionId.localeCompare(b.submissionId)),
  );
}

export function summarizeWorkbookAnalysis(
  input: readonly WorkbookAnalysisResult[],
) {
  const results = [...new Map(input.map((r) => [r.submissionId, r])).values()];
  const groups = new Map<
    string,
    { name: string; correct: number; total: number; referenceOnly: boolean }
  >();
  const types = new Map<
    string,
    { name: string; correct: number; total: number; referenceOnly: boolean }
  >();
  const misses = new Map<
    string,
    { label: string; wrong: number; total: number }
  >();
  let correct = 0,
    total = 0,
    unclassified = 0;
  for (const r of results)
    for (const q of r.questions) {
      total++;
      correct += q.correct;
      if (!q.tags.length) unclassified++;
      const miss = misses.get(q.bookQuestionId) ?? {
        label: `${r.bookLabel} · ${q.page}쪽 ${q.number}번`,
        wrong: 0,
        total: 0,
      };
      miss.total++;
      miss.wrong += 1 - q.correct;
      misses.set(q.bookQuestionId, miss);
      const areas = [...new Set(q.tags.map((t) => t.area))];
      for (const [map, entries] of [
        [
          groups,
          areas.map((name) => ({
            id: r.subject + ':' + name,
            name,
            referenceOnly: q.tags
              .filter((t) => t.area === name)
              .every((t) => t.referenceOnly),
          })),
        ],
        [
          types,
          q.tags.map((t) => ({
            id: t.tagId,
            name: t.name,
            referenceOnly: t.referenceOnly,
          })),
        ],
      ] as const)
        for (const entry of entries) {
          const stat = map.get(entry.id) ?? {
            name: entry.name,
            correct: 0,
            total: 0,
            referenceOnly: entry.referenceOnly,
          };
          stat.correct += q.correct;
          stat.total++;
          map.set(entry.id, stat);
        }
    }
  return { results, correct, total, unclassified, groups, types, misses };
}
