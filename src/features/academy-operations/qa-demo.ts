/** Explicit synthetic demo preparation. Never called during application startup. */
import { createHash } from 'node:crypto';
import type { OperationsDatabase } from './database.ts';
import { getActor } from './directory.ts';
import { homeworkModule } from './homework.ts';
import { assignedQuestions } from './workbook-results.ts';
import {
  readWorkbookAnalysis,
  workbookFingerprint,
} from './workbook-analysis.ts';
import {
  publishWorkbookAnalysis,
  workbookEvidence,
} from './workbook-publication.ts';
import { teamScheduleModule } from './team-schedule.ts';
import { scheduleModule } from './schedule.ts';
import { one, rows, transaction, OperationError } from './shared.ts';
import type {
  AcademyConfig,
  ScheduleState,
} from '../makeup-schedule/model/types.ts';

const form = (values: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [key, value] of Object.entries(values))
    for (const v of Array.isArray(value) ? value : [value]) f.append(key, v);
  return f;
};
const academyId = 'AC_TEST_A';
const demoUuid = (label: string) => {
  const hex = createHash('sha256')
    .update('axr-qa-demo-v1:' + label)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

export async function prepareQADemo(
  db: OperationsDatabase,
  date = '2026-11-16',
) {
  if (
    one<{ name: string }>(
      db,
      'SELECT name FROM academies WHERE id=?',
      academyId,
    )?.name !== '[가상] 테스트 교습소'
  )
    throw new OperationError('가상 테스트 교습소에서만 실행할 수 있습니다.');
  // Give the second synthetic learner the existing demo password; never embed a credential.
  db.prepare(
    `INSERT OR IGNORE INTO accounts(id,academy_id,username,name,role,student_id,password_hash)
    SELECT 'TA_STUDENT_002',academy_id,'TA_STUDENT_002','가상학생B','student','TA_STU_002',password_hash
    FROM accounts WHERE id='TA_STUDENT_001' AND academy_id=?`,
  ).run(academyId);
  const ctx = (user = 'TA_DIRECTOR') => {
    const actor = getActor(db, user);
    if (!actor || actor.academyId !== academyId)
      throw new OperationError('가상 계정이 없습니다.');
    return { db, actor, url: new URL('http://localhost/schedule') };
  };
  const record = () =>
    one<{ version: number; config: string; state: string }>(
      db,
      'SELECT * FROM op_team_schedule WHERE academy_id=?',
      academyId,
    );
  const saveSchedule = (fields: Record<string, string>) =>
    teamScheduleModule.submit(
      ctx(),
      form({ version: String(record()?.version ?? 0), ...fields }),
    );
  const previous = record();
  const config = previous
    ? (JSON.parse(previous.config) as AcademyConfig)
    : {
        capacity: 9,
        closeTime: '22:00',
        rooms: ['1강의실'],
        classes: [],
        holidays: {},
      };
  const missing = [
    { classId: 'TA_E_MATH', days: [1, 3], start: '16:00', end: '17:00' },
    { classId: 'TA_M2_EXAM', days: [1, 3], start: '17:00', end: '18:00' },
    { classId: 'TA_M3', days: [2, 4], start: '18:00', end: '19:00' },
    { classId: 'TA_H1', days: [2, 4], start: '19:00', end: '20:00' },
  ].filter((c) => !config.classes.some((x) => x.classId === c.classId));
  if (config.capacity !== 9 || missing.length)
    await saveSchedule({
      action: 'config',
      config: JSON.stringify({
        ...config,
        capacity: 9,
        classes: [
          ...config.classes,
          ...missing.map((c) => ({
            ...c,
            teacher: 'TA_TEACHER',
            room: config.rooms[0],
          })),
        ],
      }),
    });
  const state = JSON.parse(record()!.state) as ScheduleState;
  if (
    !state.events.some(
      (e) =>
        e.classId === 'TA_E_MATH' &&
        e.date === '2026-11-25' &&
        e.status !== 'withdrawn',
    )
  )
    await saveSchedule({
      action: 'create',
      scope: 'class',
      classId: 'TA_E_MATH',
      date: '2026-11-25',
      makeupDate: '2026-11-28',
      makeupStart: '14:00',
      room: config.rooms[0],
      confirm: 'yes',
      reason: '[가상 QA] 발표 시연용 휴강·보강',
    });
  if (!state.availability?.TA_STU_001?.length)
    await saveSchedule({
      action: 'availability',
      studentId: 'TA_STU_001',
      windows: JSON.stringify([{ day: 6, start: '13:00', end: '17:00' }]),
    });

  let createdHomework = 0,
    published = 0,
    slots = 0;
  for (const [studentId, account, classId, tag] of [
    ['TA_STU_001', 'TA_STUDENT_001', 'TA_E_MATH', 'math-01'],
    ['TA_STU_002', 'TA_STUDENT_002', 'TA_M2_EXAM', 'math-07'],
  ]) {
    const id = demoUuid(studentId + ':' + date);
    if (!one(db, 'SELECT 1 FROM homework_assignments WHERE id=?', id)) {
      await homeworkModule.submit(
        ctx(),
        form({
          action: 'assign-workbook',
          assignmentId: id,
          subject: 'M',
          book: '[가상 QA] 학습 점검',
          edition: '시연용',
          title: '[가상 QA] ' + date + ' 유형별 복습',
          date,
          targetKind: 'student',
          recipient: classId + '|' + studentId,
          items: JSON.stringify(
            Array.from({ length: 6 }, (_, i) => ({
              page: studentId === 'TA_STU_001' ? 1 : 2,
              number: String(i + 1),
              tagIds: [i < 4 ? tag : 'math-04'],
            })),
          ),
        }),
      );
      createdHomework++;
    }
    const priorSubmission = one<{
      id: string;
      review_version: number;
      confirmed_at: string | null;
    }>(
      db,
      'SELECT id,review_version,confirmed_at FROM homework_submissions WHERE assignment_id=? AND student_id=?',
      id,
      studentId,
    );
    if (!priorSubmission?.confirmed_at && !priorSubmission?.review_version) {
      const questions = assignedQuestions(ctx(), id);
      const wrong = questions.slice(0, 3).map((q) => q.id);
      if (!priorSubmission)
        await homeworkModule.submit(
          ctx(account),
          form({ action: 'report', assignmentId: id, wrong }),
        );
      const submission = one<{ id: string }>(
        db,
        'SELECT id FROM homework_submissions WHERE assignment_id=? AND student_id=?',
        id,
        studentId,
      )!;
      await homeworkModule.submit(
        ctx(),
        form({
          action: 'approve-workbook',
          assignmentId: id,
          single: submission.id,
          ['version-' + submission.id]: '0',
          ['wrong-' + submission.id]: wrong,
        }),
      );
    }
    const period = date.slice(0, 7);
    if (
      !workbookEvidence(db, academyId).documents.some(
        (d) => d.studentId === studentId && d.classId === classId,
      )
    ) {
      const results = readWorkbookAnalysis(db, academyId).results.filter(
        (r) =>
          r.studentId === studentId &&
          r.classes.some((c) => c.id === classId) &&
          r.dueDate.slice(0, 7) === period,
      );
      const revision =
        one<{ revision: number }>(
          db,
          "SELECT MAX(revision) revision FROM op_learning_publications WHERE academy_id=? AND student_id=? AND class_id=? AND period=? AND id LIKE 'workbook-%'",
          academyId,
          studentId,
          classId,
          period,
        )?.revision ?? 0;
      await publishWorkbookAnalysis(
        ctx(),
        form({
          studentId,
          classId,
          period,
          publicationRevision: String(revision),
          fingerprint: workbookFingerprint(results),
        }),
      );
      published++;
    }
  }
  // Appointments are always in the future and never overwrite existing slots.
  const day = new Date(Date.now() + 2 * 86400000 + 32400000)
    .toISOString()
    .slice(0, 10);
  for (const [staff, time] of [
    ['TA_DIRECTOR', '11'],
    ['TA_TEACHER', '12'],
  ]) {
    const startsAt = Date.parse(`${day}T${time}:00:00+09:00`);
    if (
      one(
        db,
        'SELECT 1 FROM ops_consultation_slots WHERE academy_id=? AND staff_id=? AND starts_at=? AND revoked_at IS NULL',
        academyId,
        staff,
        startsAt,
      )
    )
      continue;
    await scheduleModule.submit(
      ctx(),
      form({
        action: 'save_slot',
        staff_id: staff,
        slot_start: `${day}T${time}:00`,
        slot_end: `${day}T${time}:30`,
      }),
    );
    slots++;
  }
  // Preserve history; only archive exact, duplicate QA probes without staff replies.
  const duplicates = rows<{ id: string }>(
    db,
    `SELECT t.id FROM op_consultation_threads t WHERE t.academy_id=? AND t.title=? AND t.status IN ('open','requested')
      AND NOT EXISTS(SELECT 1 FROM op_consultation_messages m WHERE m.thread_id=t.id AND m.kind='staff')
      ORDER BY t.updated_at DESC,t.id`,
    academyId,
    '11월 23일 휴강 보강 언제예요?',
  ).slice(1);
  transaction(db, () => {
    for (const t of duplicates)
      db.prepare(
        "UPDATE op_consultation_threads SET status='closed',version=version+1 WHERE id=?",
      ).run(t.id);
  });
  return {
    createdHomework,
    published,
    addedClasses: missing.length,
    capacity: 9,
    slots,
    archivedDuplicates: duplicates.length,
  };
}
