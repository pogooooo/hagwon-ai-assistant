import { accountDisplayName, isAcceptanceRecord } from './demo-presentation.ts';
import { randomUUID } from 'node:crypto';
import { setupKnowledge, knowledgeEvidence } from './knowledge.ts';
import {
  setupSchools,
  schoolEvidence,
  schoolQuerySelection,
} from './schools.ts';
import { operationsGeneration } from './runtime-generation.ts';
import { workbookEvidence } from './workbook-publication.ts';
import {
  learningEvidence,
  learningLabels,
  learningTypes,
  setupLearning,
} from './learning.ts';
import {
  teamScheduleEvidence,
  setupTeamSchedule,
  regularScheduleDocuments,
} from './team-schedule.ts';
import { scheduleAuthority } from './schedule-authority.ts';
import type { OperationsDatabase } from './database.ts';

import type {
  RagAnswer,
  RagAnswerStatus,
} from '../rag-consultation/contract.ts';
import {
  createRagConsultationService,
  InMemoryHandoffStore,
  SystemClock,
  InMemoryRagStore,
  type AcademyCatalog,
  type ConversationState,
} from '../rag-consultation/server/index.ts';
import { canReadRecord } from '../rag-consultation/server/retrieval/access-filter.ts';
import type { RagAccessScope } from '../rag-consultation/server/types.ts';
import {
  accessibleClasses,
  accessibleStudents,
  getActor,
} from './directory.ts';
import {
  buildDocumentsIndex,
  documentsIndexVersion,
  currentDocumentRevisions,
} from './documents.ts';
import { scheduleDocuments, scheduleFacts } from './schedule.ts';
import { pollScheduleEvidence } from './makeup-polls.ts';
import {
  escapeHtml as h,
  field,
  one,
  OperationError,
  required,
  rows,
  transaction,
  type Actor,
  type OperationModule,
  type PageContext,
} from './shared.ts';

type ThreadStatus = 'open' | 'requested' | 'assigned' | 'closed';
const threadLabels: Record<ThreadStatus, string> = {
  open: '내 상담',
  requested: '담당자 연결 요청',
  assigned: '담당자 배정',
  closed: '완료',
};
const answerLabels: Record<RagAnswerStatus, string> = {
  answered: '답변',
  partial: '부분 답변',
  abstained: '자료 확인 필요',
  clarify: '추가 확인 필요',
  denied: '조회 범위 제한',
  handoff: '추가 확인이 필요한 질문',
};

interface Thread {
  id: string;
  academy_id: string;
  owner_id: string;
  assignee_id: string | null;
  title: string;
  status: ThreadStatus;
  student_scope: string;
  class_scope: string;
  staff_scope: number;
  conversation_state: string | null;
  version: number;
  updated_at: string;
}

interface Message {
  kind: 'question' | 'answer' | 'staff';
  text: string;
  response: string | null;
  created_at: string;
}

function setupConsultation(db: OperationsDatabase) {
  setupKnowledge(db);
  setupSchools(db);
  setupLearning(db);
  setupTeamSchedule(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS op_consultation_threads (
      id TEXT PRIMARY KEY,
      academy_id TEXT NOT NULL REFERENCES academies(id),
      owner_id TEXT NOT NULL REFERENCES accounts(id),
      assignee_id TEXT REFERENCES accounts(id),
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('open', 'requested', 'assigned', 'closed')),
      student_scope TEXT NOT NULL,
      class_scope TEXT NOT NULL,
      staff_scope INTEGER NOT NULL CHECK(staff_scope IN (0, 1)),
      conversation_state TEXT,
      version INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS op_consultation_thread_lookup
      ON op_consultation_threads(academy_id, owner_id, status);
    CREATE TABLE IF NOT EXISTS op_consultation_messages (
      id INTEGER PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES op_consultation_threads(id),
      kind TEXT NOT NULL CHECK(kind IN ('question', 'answer', 'staff')),
      text TEXT NOT NULL,
      response TEXT,
      created_at TEXT NOT NULL
    );
  `);
}

function isStaff(actor: Actor) {
  return actor.role === 'admin' || actor.role === 'teacher';
}

export function canAskConsultation(actor: Actor) {
  return actor.role === 'guardian' || actor.role === 'student';
}

function coversScope(db: OperationsDatabase, actor: Actor, thread: Thread) {
  if (thread.staff_scope && !isStaff(actor)) return false;
  const students = new Set(accessibleStudents(db, actor).map(({ id }) => id));
  const classes = new Set(accessibleClasses(db, actor).map(({ id }) => id));
  return (
    (JSON.parse(thread.student_scope) as string[]).every((id) =>
      students.has(id),
    ) &&
    (JSON.parse(thread.class_scope) as string[]).every((id) => classes.has(id))
  );
}

function canViewThread(ctx: PageContext, thread: Thread) {
  const { actor, db } = ctx;
  if (thread.academy_id !== actor.academyId) return false;
  if (canAskConsultation(actor))
    return thread.owner_id === actor.id && coversScope(db, actor, thread);
  if (actor.role === 'admin') return thread.status !== 'open';
  return (
    actor.role === 'teacher' &&
    thread.status !== 'open' &&
    thread.assignee_id === actor.id &&
    coversScope(db, actor, thread)
  );
}

// Keep staff-authored legacy records out of the student and family inbox.
const familyThreads = `SELECT t.* FROM op_consultation_threads t
  JOIN accounts a ON a.id=t.owner_id AND a.academy_id=t.academy_id
  WHERE a.role IN ('guardian','student') AND t.staff_scope=0 AND t.academy_id=?`;
export function loadThread(ctx: PageContext, id: string) {
  const thread = one<Thread>(
    ctx.db,
    familyThreads + ' AND t.id=?',
    ctx.actor.academyId,
    id,
  );
  if (!thread || !canViewThread(ctx, thread)) {
    throw new OperationError('상담 기록을 찾을 수 없습니다.', 404);
  }
  return thread;
}

function visibleThreads(ctx: PageContext) {
  return rows<Thread>(
    ctx.db,
    familyThreads + ' ORDER BY t.updated_at DESC, t.id',
    ctx.actor.academyId,
  ).filter((thread) => canViewThread(ctx, thread));
}

function needsStaffAttention(actor: Actor, thread: Thread) {
  return (
    (thread.status === 'requested' && actor.role === 'admin') ||
    (thread.status === 'assigned' &&
      (actor.role === 'admin' || thread.assignee_id === actor.id))
  );
}

export function consultationOverview(ctx: PageContext) {
  if (!isStaff(ctx.actor) && !canAskConsultation(ctx.actor))
    return { pending: [], recent: [] };
  const threads = visibleThreads(ctx);
  return {
    pending: threads
      .filter((thread) => needsStaffAttention(ctx.actor, thread))
      .filter(
        (thread) => !isAcceptanceRecord(ctx.actor.academyId, thread.title),
      )
      .map((thread) => toOverviewItem(ctx, thread)),
    recent: threads
      .filter(
        (thread) =>
          thread.owner_id === ctx.actor.id &&
          !isAcceptanceRecord(ctx.actor.academyId, thread.title),
      )
      .slice(0, 4)
      .map((thread) => toOverviewItem(ctx, thread)),
  };
}

function threadDetail(ctx: PageContext, thread: Thread) {
  const messages = rows<Message>(
    ctx.db,
    'SELECT kind, text, response, created_at FROM op_consultation_messages WHERE thread_id=? ORDER BY id',
    thread.id,
  );
  let question = thread.title;
  let latestQuestion = question;
  let unresolved:
    (RagAnswer & { operations?: { studentIds: string[] } }) | undefined;
  let lastAnswer: typeof unresolved;
  for (const message of messages) {
    if (message.kind === 'question') latestQuestion = message.text;
    if (!message.response) continue;
    const answer = JSON.parse(message.response) as NonNullable<
      typeof unresolved
    >;
    lastAnswer = answer;
    if (['abstained', 'partial', 'handoff'].includes(answer.status)) {
      question = latestQuestion;
      unresolved = answer;
    }
  }
  const account = one<{ name: string; role: Actor['role'] }>(
    ctx.db,
    'SELECT name,role FROM accounts WHERE academy_id=? AND id=?',
    ctx.actor.academyId,
    thread.owner_id,
  );
  const owner = account
    ? accountDisplayName(thread.academy_id, account.name, account.role)
    : '탈퇴 계정';
  if (!unresolved || messages.at(-1)?.kind === 'question')
    question = latestQuestion;
  const targets = (
    (unresolved ?? lastAnswer)?.operations?.studentIds ?? []
  ).flatMap((id) => {
    const student = one<{ name: string }>(
      ctx.db,
      'SELECT name FROM students WHERE academy_id=? AND id=?',
      ctx.actor.academyId,
      id,
    );
    return student ? [student.name] : [];
  });
  return {
    question,
    owner,
    lastKind: messages.at(-1)?.kind,
    latestNote:
      messages.findLast((message) => message.kind !== 'answer')?.text ??
      thread.title,
    receivedAt: messages[0]?.created_at ?? thread.updated_at,
    target: targets.join(', '),
  };
}

const inquiryDate = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function inquiryTime(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? `<time datetime="${h(value)}">${h(inquiryDate.format(date))} 접수</time>`
    : '';
}

function participantLabel(detail: ReturnType<typeof threadDetail>) {
  return detail.target && detail.target !== detail.owner
    ? detail.owner + ' · ' + detail.target
    : detail.owner;
}

function toOverviewItem(ctx: PageContext, thread: Thread) {
  const detail = threadDetail(ctx, thread);
  return {
    id: thread.id,
    title: thread.status === 'open' ? thread.title : detail.question,
    label: `${threadLabels[thread.status]} · ${participantLabel(detail)}`,
  };
}

function addMessage(
  db: OperationsDatabase,
  id: string,
  kind: Message['kind'],
  text: string,
  at: string,
  response?: RagAnswer,
) {
  db.prepare(
    `
    INSERT INTO op_consultation_messages (thread_id, kind, text, response, created_at)
    VALUES (?, ?, ?, ?, ?)
  `,
  ).run(id, kind, text, response ? JSON.stringify(response) : null, at);
}

/** The hosted trial inbox has actionable synthetic cases. Staff changes survive a restart. */
export function seedDemoConsultationInbox(db: OperationsDatabase) {
  const academies = [
    {
      id: 'AC_TEST_A',
      name: '[가상] 테스트 교습소',
      guardian: 'TA_GUARDIAN_E_MATH',
      teacher: 'TA_TEACHER',
      student: 'TA_STU_001',
      classroom: 'TA_E_MATH',
      questions: [
        '분수 뺄셈에서 통분하는 순서를 자주 헷갈려요. 어떤 문제부터 다시 풀면 좋을까요?',
        '수업을 마치고 10분 정도 면담할 수 있는 날이 있을까요?',
      ],
      ids: [
        '5b476a4f-e8a7-4531-9e5f-74caf26e6a6c',
        'b0d1473b-d8a9-460d-99c2-8aa97753aa51',
      ],
      trialId: '679ed154-e98b-4c93-a869-4c957b061c44',
      trialQuestion:
        '분수 계산에서 같은 유형을 계속 틀려요. 어떤 유형부터 복습하면 좋을까요?',
    },
    {
      id: 'AC_ONDAP_LANGUAGE_DEMO',
      name: '[가상] 온답 어학원',
      guardian: 'ONDAP_LANGUAGE_TA_GUARDIAN_E_MATH',
      teacher: 'ONDAP_LANGUAGE_TA_TEACHER',
      student: 'ONDAP_DEMO_LEARNER',
      classroom: 'ONDAP_DEMO_ENGLISH',
      questions: [
        '아이가 시간을 말할 때 at과 on을 자주 바꿔 써요. 집에서는 어떤 문장으로 연습하면 좋을까요?',
        '다음 주에 영어 회화반 수업에 관해 방문 상담을 예약할 수 있을까요?',
      ],
      ids: [
        'c5f940d3-b1db-4c0a-a9d7-0561159d1b61',
        '8dc3013b-28f9-4233-b6d4-5221e3067635',
      ],
      trialId: '7633856f-15de-4e2d-8f2d-85aadc4511d3',
      trialQuestion:
        '영어 문장을 소리 내어 읽는 연습은 어떤 문장부터 시작하면 좋을까요?',
    },
  ];
  for (const academy of academies) {
    if (
      !one(
        db,
        'SELECT 1 FROM academies WHERE id=? AND name=?',
        academy.id,
        academy.name,
      )
    )
      continue;
    const cases = [
      {
        id: academy.ids[0],
        question: academy.questions[0],
        guardian: getActor(db, academy.guardian),
        teacher: getActor(db, academy.teacher),
        assigned: true,
        studentId: academy.student,
      },
      {
        id: academy.ids[1],
        question: academy.questions[1],
        guardian: getActor(db, academy.guardian),
        teacher: getActor(db, academy.teacher),
        assigned: false,
        studentId: academy.student,
      },
    ];
    const trialActor = (slot: 'parent' | 'teacher') => {
      const row = one<{ id: string }>(
        db,
        `SELECT a.id FROM op_demo_logins_v1 d JOIN accounts a ON a.academy_id=?
        WHERE d.slot=? AND (
          a.id=d.account_id OR (a.id='ONDAP_LANGUAGE_'||d.account_id AND EXISTS (
            SELECT 1 FROM op_academy_memberships m
            WHERE m.login_id=d.account_id AND m.profile_id=a.id
          ))
        )`,
        academy.id,
        slot,
      );
      return row ? getActor(db, row.id) : undefined;
    };
    const trialGuardian = trialActor('parent');
    const trialTeacher = trialActor('teacher');
    if (
      trialGuardian &&
      trialTeacher &&
      trialGuardian.id !== academy.guardian &&
      trialTeacher.id !== academy.teacher
    ) {
      const learnerIds = new Set(
        accessibleStudents(db, trialTeacher)
          .filter((student) => student.classIds.includes(academy.classroom))
          .map((student) => student.id),
      );
      const learner = accessibleStudents(db, trialGuardian).find(
        (student) =>
          learnerIds.has(student.id) &&
          student.classIds.includes(academy.classroom),
      );
      if (learner)
        cases.push({
          id: academy.trialId,
          question: academy.trialQuestion,
          guardian: trialGuardian,
          teacher: trialTeacher,
          assigned: true,
          studentId: learner.id,
        });
    }
    transaction(db, () => {
      const now = new Date().toISOString();
      for (const entry of cases) {
        const { guardian, teacher } = entry;
        if (
          guardian?.role !== 'guardian' ||
          guardian.academyId !== academy.id ||
          teacher?.role !== 'teacher' ||
          teacher.academyId !== academy.id ||
          ![guardian, teacher].every((actor) =>
            accessibleStudents(db, actor).some(
              (student) =>
                student.id === entry.studentId &&
                student.classIds.includes(academy.classroom),
            ),
          )
        )
          continue;
        const inserted = db
          .prepare(
            'INSERT OR IGNORE INTO op_consultation_threads(id,academy_id,owner_id,assignee_id,title,status,student_scope,class_scope,staff_scope,updated_at) VALUES(?,?,?,?,?,?,?,?,0,?)',
          )
          .run(
            entry.id,
            academy.id,
            guardian.id,
            entry.assigned ? teacher.id : null,
            entry.question,
            entry.assigned ? 'assigned' : 'requested',
            JSON.stringify([entry.studentId]),
            JSON.stringify([academy.classroom]),
            now,
          );
        if (inserted.changes)
          addMessage(db, entry.id, 'question', entry.question, now);
      }
    });
  }
}

function currentCatalog({ db, actor }: PageContext): AcademyCatalog {
  const name =
    one<{ name: string }>(
      db,
      'SELECT name FROM academies WHERE id = ?',
      actor.academyId,
    )?.name ?? '학원';
  const classes = rows<{
    id: string;
    name: string;
    subject: string;
    grade: string;
  }>(
    db,
    'SELECT id, name, subject, grade FROM classes WHERE academy_id = ?',
    actor.academyId,
  );
  const students = rows<{ id: string; name: string }>(
    db,
    'SELECT id, name FROM students WHERE academy_id = ?',
    actor.academyId,
  );
  return {
    academyId: actor.academyId,
    displayName: name,
    aliases: [name, name.replace(/^\[가상\]\s*/, '')],
    classes: classes.map(({ id, name, subject, grade }) => ({
      classId: id,
      name,
      aliases: [name, name.replace(/반$/, '').trim()],
      subject,
      grade,
    })),
    units: learningLabels,
    questionTypes: learningTypes,
    studentDirectory: students.map(({ id, name }) => ({
      studentId: id,
      names: [name, name.replace(/^가상/, '')],
    })),
  };
}

function consultationAccess({ db, actor }: PageContext): RagAccessScope {
  const students = accessibleStudents(db, actor);
  return {
    actorId: actor.id,
    academyId: actor.academyId,
    role: actor.role,
    allowedStudentIds: students.map(({ id }) => id),
    allowedClassIds: accessibleClasses(db, actor).map(({ id }) => id),
    studentRefs: students.map(({ id, name, classIds }) => ({
      studentId: id,
      displayLabel: name,
      aliases: [name, name.replace(/^가상/, '')],
      classIds,
    })),
    canViewPublicHistory: false,
  };
}

function supplementaryEvidence(db: OperationsDatabase, academyId: string) {
  const learning = learningEvidence(db, academyId);
  const workbook = workbookEvidence(db, academyId);
  const team = teamScheduleEvidence(db, academyId);
  const polls = pollScheduleEvidence(db, academyId);
  const schedule = {
    documents: [
      ...scheduleDocuments(db, academyId),
      ...team.map((x) => x.document),
      ...regularScheduleDocuments(db, academyId),
      ...polls.documents,
    ],
    facts: [
      ...scheduleFacts(db, academyId),
      ...team.flatMap((x) => x.facts),
      ...polls.facts,
    ],
  };
  return {
    schedule,
    documents: [
      ...knowledgeEvidence(db, academyId),
      ...schoolEvidence(db, academyId),
      ...schedule.documents,
      ...learning.documents,
      ...workbook.documents,
    ],
    facts: [...schedule.facts, ...learning.facts, ...workbook.facts],
  };
}

export async function ask(ctx: PageContext, form: FormData, existing?: Thread) {
  const { db, actor } = ctx;
  if (!canAskConsultation(actor))
    throw new OperationError('학생과 학부모만 질문할 수 있습니다.', 403);
  if (
    existing &&
    (existing.owner_id !== actor.id || existing.status === 'closed')
  ) {
    throw new OperationError('진행 중인 내 상담에서 질문해 주세요.', 403);
  }
  const question = required(form, 'question', '질문', 500);
  const studentId = field(form, 'studentId', 128);
  const access = consultationAccess(ctx);
  const {
    allowedStudentIds: currentStudentIds,
    allowedClassIds: currentClassIds,
  } = access;
  if (studentId && !currentStudentIds.includes(studentId)) {
    throw new OperationError('조회 가능한 학생을 선택해 주세요.', 403);
  }
  const conversationId = existing?.id ?? field(form, 'conversationId', 40);
  if (!/^[a-f0-9-]{36}$/.test(conversationId)) {
    throw new OperationError('상담 화면을 다시 열어 주세요.');
  }
  if (
    existing &&
    (existing.status === 'requested' || existing.status === 'assigned')
  ) {
    transaction(db, () => {
      ctx.assertCurrentAccess?.();
      const thread = loadThread(ctx, existing.id);
      const widened = {
        ...thread,
        student_scope: mergeScope(thread.student_scope, currentStudentIds),
        class_scope: mergeScope(thread.class_scope, currentClassIds),
      };
      const assignee = thread.assignee_id && getActor(db, thread.assignee_id);
      const keepAssignment =
        assignee && isStaff(assignee) && coversScope(db, assignee, widened);
      const at = new Date().toISOString();
      const updated = db
        .prepare(
          "UPDATE op_consultation_threads SET student_scope=?,class_scope=?,status=?,assignee_id=?,updated_at=?,version=version+1 WHERE id=? AND owner_id=? AND version=? AND status IN ('requested','assigned')",
        )
        .run(
          widened.student_scope,
          widened.class_scope,
          keepAssignment ? 'assigned' : 'requested',
          keepAssignment ? thread.assignee_id : null,
          at,
          thread.id,
          actor.id,
          existing.version,
        );
      if (!updated.changes)
        throw new OperationError(
          '상담 내용이 변경됐습니다. 다시 열어 주세요.',
          409,
        );
      addMessage(db, thread.id, 'question', question, at);
    });
    return conversationId;
  }
  let conversation: ConversationState | null = existing?.conversation_state
    ? (JSON.parse(existing.conversation_state) as ConversationState)
    : null;
  const catalog = currentCatalog(ctx);
  const {
    documents: notices,
    facts: noticeFacts,
    schedule,
  } = supplementaryEvidence(db, actor.academyId);
  const indexVersion = documentsIndexVersion(
    db,
    actor.academyId,
    notices,
    noticeFacts,
  );
  const store = await buildDocumentsIndex(
    db,
    actor.academyId,
    notices,
    noticeFacts,
  );
  const schoolSelection = schoolQuerySelection(ctx, question, studentId);
  const schoolStore = schoolSelection ? new InMemoryRagStore() : undefined;
  if (schoolStore && schoolSelection)
    for (const document of schoolSelection.documents)
      await schoolStore.upsertIndexedRevision({
        document,
        facts: [],
        approve: true,
      });
  const service = createRagConsultationService({
    config: schoolSelection?.config,
    facts: store,
    documents: store,
    selectEvidence: schoolStore
      ? () => ({ documents: schoolStore, facts: schoolStore })
      : await scheduleAuthority(schedule.documents, schedule.facts),
    catalog: { getAcademyCatalog: async () => catalog },
    generation: operationsGeneration(),
    handoff: new InMemoryHandoffStore(),
    conversations: {
      load: async () => conversation,
      save: async (_actorId, _conversationId, state) => {
        conversation = state;
      },
    },
    clock: new SystemClock(),
    engine: 'planned',
  });
  const { answer, trace } = await service.query({
    question,
    conversationId,
    studentIdHint: studentId || undefined,
    access,
  });
  if (schoolSelection?.clarify?.length && answer.status !== 'denied') {
    answer.status = 'clarify';
    answer.answer =
      '확인된 시험 일정이 여러 기간에 있습니다. 어느 시험의 날짜인지 선택해 주세요.';
    answer.citations = [];
    answer.clarifyOptions = schoolSelection.clarify;
    answer.missingFields = ['시험 적용 기간'];
    delete answer.handoff;
  }
  const at = new Date().toISOString();
  transaction(db, () => {
    ctx.assertCurrentAccess?.();
    if (JSON.stringify(consultationAccess(ctx)) !== JSON.stringify(access))
      throw new OperationError(
        '상담 열람 권한이 변경되었습니다. 다시 질문해 주세요.',
        403,
      );
    const liveEvidence = supplementaryEvidence(db, actor.academyId);
    const liveVersion = documentsIndexVersion(
      db,
      actor.academyId,
      liveEvidence.documents,
      liveEvidence.facts,
    );
    if (liveVersion !== indexVersion)
      throw new OperationError(
        '승인 자료가 변경되었습니다. 다시 질문해 주세요.',
        409,
      );
    const studentScope = mergeScope(existing?.student_scope, currentStudentIds);
    const classScope = mergeScope(existing?.class_scope, currentClassIds);
    const staffScope = Number(Boolean(existing?.staff_scope) || isStaff(actor));
    if (existing) {
      const updated = db
        .prepare(
          `
        UPDATE op_consultation_threads SET conversation_state = ?, student_scope = ?,
          class_scope = ?, staff_scope = ?, updated_at = ?, version = version + 1
        WHERE academy_id = ? AND id = ? AND owner_id = ? AND version = ?
      `,
        )
        .run(
          JSON.stringify(conversation),
          studentScope,
          classScope,
          staffScope,
          at,
          actor.academyId,
          conversationId,
          actor.id,
          existing.version,
        );
      if (!updated.changes)
        throw new OperationError(
          '상담 내용이 변경됐습니다. 새로 열어 주세요.',
          409,
        );
    } else {
      const created = db
        .prepare(
          `
        INSERT OR IGNORE INTO op_consultation_threads
          (id, academy_id, owner_id, title, status, student_scope, class_scope,
            staff_scope, conversation_state, updated_at)
        VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)
      `,
        )
        .run(
          conversationId,
          actor.academyId,
          actor.id,
          question.slice(0, 65),
          studentScope,
          classScope,
          staffScope,
          JSON.stringify(conversation),
          at,
        );
      if (!created.changes)
        throw new OperationError(
          '이미 제출된 상담입니다. 목록을 새로 열어 주세요.',
          409,
        );
    }
    const targets = trace.targetStudentIds.length
      ? trace.targetStudentIds
      : studentId
        ? [studentId]
        : currentStudentIds.length === 1
          ? currentStudentIds
          : [];
    const storedAnswer = {
      ...answer,
      answer: answer.answer
        .replaceAll('연결해 드리겠습니다.', '연결을 요청할 수 있습니다.')
        .replaceAll('연결해 드립니다.', '연결을 요청할 수 있습니다.'),
      operations: {
        studentIds: targets.filter((id) => currentStudentIds.includes(id)),
      },
    };
    addMessage(db, conversationId, 'question', question, at);
    addMessage(
      db,
      conversationId,
      'answer',
      storedAnswer.answer,
      at,
      storedAnswer,
    );
  });
  return conversationId;
}

function mergeScope(previous: string | undefined, ids: readonly string[]) {
  return JSON.stringify([
    ...new Set([
      ...(previous ? (JSON.parse(previous) as string[]) : []),
      ...ids,
    ]),
  ]);
}

function eligibleAssignees(ctx: PageContext, thread: Thread) {
  return rows<{ id: string }>(
    ctx.db,
    "SELECT id FROM accounts WHERE academy_id = ? AND role IN ('admin', 'teacher') ORDER BY name",
    ctx.actor.academyId,
  ).flatMap(({ id }) => {
    const actor = getActor(ctx.db, id);
    return actor && coversScope(ctx.db, actor, thread) ? [actor] : [];
  });
}

async function submitConsultation(ctx: PageContext, form: FormData) {
  const action = field(form, 'action');
  const id = field(form, 'id', 40);
  if (action === 'ask') {
    const conversationId = await ask(
      ctx,
      form,
      id ? loadThread(ctx, id) : undefined,
    );
    return '/consultation?id=' + encodeURIComponent(conversationId);
  }
  if (['handoff', 'resume'].includes(action) && !canAskConsultation(ctx.actor))
    throw new OperationError(
      '학생과 학부모만 담당자 상담을 요청하거나 취소할 수 있습니다.',
      403,
    );
  if (!id) throw new OperationError('상담 기록을 찾을 수 없습니다.', 404);
  transaction(ctx.db, () => {
    ctx.assertCurrentAccess?.();
    submitThreadAction(ctx, form, action, loadThread(ctx, id));
  });
}

function submitThreadAction(
  ctx: PageContext,
  form: FormData,
  action: string,
  thread: Thread,
) {
  const { db, actor } = ctx;
  const now = new Date().toISOString();
  if (
    action === 'resume' &&
    thread.owner_id === actor.id &&
    thread.status === 'requested'
  ) {
    db.prepare(
      "UPDATE op_consultation_threads SET status='open',assignee_id=NULL,updated_at=?,version=version+1 WHERE id=?",
    ).run(now, thread.id);
    return;
  }
  if (
    action === 'handoff' &&
    thread.owner_id === actor.id &&
    thread.status === 'requested'
  )
    return;
  if (
    action === 'handoff' &&
    thread.owner_id === actor.id &&
    thread.status === 'open'
  ) {
    db.prepare(
      `
      UPDATE op_consultation_threads SET status = 'requested', updated_at = ?, version = version + 1
      WHERE id = ?
    `,
    ).run(now, thread.id);
    return;
  }
  if (
    action === 'assign' &&
    actor.role === 'admin' &&
    (thread.status === 'requested' || thread.status === 'assigned')
  ) {
    const assignee = required(form, 'assignee', '담당자', 128);
    if (!eligibleAssignees(ctx, thread).some(({ id }) => id === assignee)) {
      throw new OperationError(
        '이 상담 자료를 열람할 수 있는 담당자를 선택해 주세요.',
      );
    }
    db.prepare(
      `
      UPDATE op_consultation_threads SET assignee_id = ?, status = 'assigned',
        updated_at = ?, version = version + 1 WHERE id = ?
    `,
    ).run(assignee, now, thread.id);
    return;
  }
  if (
    (action === 'reply' || action === 'close') &&
    (actor.role === 'admin' ||
      (actor.role === 'teacher' && thread.assignee_id === actor.id)) &&
    (thread.status === 'requested' || thread.status === 'assigned')
  ) {
    if (action === 'reply') {
      addMessage(
        db,
        thread.id,
        'staff',
        required(form, 'text', '답변', 1000),
        now,
      );
    }
    db.prepare(
      `
      UPDATE op_consultation_threads SET status = ?, assignee_id = COALESCE(assignee_id, ?),
        updated_at = ?, version = version + 1 WHERE id = ?
    `,
    ).run(action === 'close' ? 'closed' : 'assigned', actor.id, now, thread.id);
    return;
  }
  throw new OperationError('이 상담에서 실행할 수 없는 작업입니다.', 403);
}

export function currentCitationRevisions(ctx: PageContext) {
  const access = consultationAccess(ctx);
  const revisions = currentDocumentRevisions(ctx);
  for (const notice of supplementaryEvidence(ctx.db, ctx.actor.academyId)
    .documents) {
    if (
      canReadRecord(
        access,
        {
          ...notice,
          classId: notice.classId ?? null,
          studentId: notice.studentId ?? null,
        },
        access.allowedStudentIds,
      )
    ) {
      revisions.set(notice.documentId, new Set([notice.revision]));
    }
  }
  return revisions;
}

function renderMessage(
  { kind, text, response }: Message,
  currentRevisions: ReadonlyMap<string, ReadonlySet<number>>,
) {
  const answer = response ? (JSON.parse(response) as RagAnswer) : null;
  if (
    answer?.citations.some(
      ({ documentId, revision }) =>
        revision === undefined ||
        !currentRevisions.get(documentId)?.has(revision),
    )
  ) {
    return '<article class="message answer"><strong>이전 답변</strong><p>자료 개정 또는 열람 범위가 변경되어 답변을 표시할 수 없습니다. 다시 질문해 주세요.</p></article>';
  }
  return `<article class="message ${kind}"${answer ? ' data-answer-status="' + h(answer.status) + '"' : ''}>
    <strong>${kind === 'question' ? '질문' : kind === 'staff' ? '담당자 답변' : h(answer ? answerLabels[answer.status] : '답변')}</strong>
    <p class="preserve">${h(text)}</p>
    ${
      answer?.citations.length
        ? `<details class="source-details"><summary>확인한 자료 ${answer.citations.length}개</summary><ul class="citations">${answer.citations
            .map((citation) => {
              const location = citation.location?.startsWith(citation.title)
                ? citation.location
                    .slice(citation.title.length)
                    .replace(/^[\s·:>/—-]+/, '')
                : citation.location;
              return `<li>${citation.documentId.startsWith('workbook-') ? `<a href="/homework?view=source&amp;publication=${encodeURIComponent(citation.documentId)}">${h(citation.title)}</a>` : citation.documentId.startsWith('learning-') ? `<a href="/learning?publication=${encodeURIComponent(citation.documentId)}">${h(citation.title)}</a>` : h(citation.title)}${location ? ' · ' + h(location) : ''}${citation.revision ? ' · v' + citation.revision : ''}</li>`;
            })
            .join('')}</ul></details>`
        : ''
    }
  </article>`;
}

function renderConsultation(ctx: PageContext) {
  const { db, actor, url } = ctx;
  if (!isStaff(actor) && !canAskConsultation(actor))
    throw new OperationError(
      '학생, 학부모와 상담 담당자가 이용할 수 있습니다.',
      403,
    );
  const id = url.searchParams.get('id');
  const thread = id ? loadThread(ctx, id) : undefined;
  const allThreads = visibleThreads(ctx);
  const actorIsStaff = isStaff(actor);
  const view = url.searchParams.get('view');
  const inbox = actorIsStaff && view !== 'archive';
  const archive = actorIsStaff && view === 'archive';
  const queue = inbox || archive;
  const scope = inbox
    ? allThreads.filter((row) => needsStaffAttention(actor, row))
    : archive
      ? allThreads.filter((row) => row.status === 'closed')
      : allThreads.filter((row) => row.owner_id === actor.id);
  const indexed = scope.map((row) => {
    const detail = threadDetail(ctx, row);
    const validation = isAcceptanceRecord(actor.academyId, row.title);
    const state =
      row.status === 'requested'
        ? 'unassigned'
        : detail.lastKind === 'staff'
          ? 'waiting'
          : 'reply';
    return { row, detail, validation, state };
  });
  const requestedStatus = url.searchParams.get('status');
  const statuses = [
    { id: 'all', label: '전체' },
    ...(actor.role === 'admin' ? [{ id: 'unassigned', label: '미배정' }] : []),
    { id: 'reply', label: '답변 대기' },
    { id: 'waiting', label: '답변 보냄' },
    ...(indexed.some(({ validation }) => validation)
      ? [{ id: 'validation', label: '검증 기록' }]
      : []),
  ];
  const status =
    requestedStatus && queue && statuses.some((s) => s.id === requestedStatus)
      ? requestedStatus
      : 'all';
  const threads = indexed.filter((item) =>
    status === 'validation'
      ? item.validation
      : !item.validation &&
        (!inbox || status === 'all' || status === item.state),
  );
  const filter =
    (inbox ? '&amp;view=inbox' : archive ? '&amp;view=archive' : '') +
    (status && status !== 'all'
      ? '&amp;status=' + encodeURIComponent(status)
      : '');
  const active =
    thread && (thread.status === 'requested' || thread.status === 'assigned');
  const staff =
    active && (actor.role === 'admin' || thread.assignee_id === actor.id);
  const own =
    canAskConsultation(actor) && (!thread || thread.owner_id === actor.id);
  const students = accessibleStudents(db, actor);
  const [classroom] = canAskConsultation(actor)
    ? accessibleClasses(db, actor)
    : [];
  const suggestions = [
    '수업 대상 학년을 알려주세요.',
    '학원 운영시간을 알려주세요.',
    classroom
      ? classroom.name + ' 시간표를 알려주세요.'
      : '상담은 어떻게 신청하나요?',
  ];
  const messages = thread
    ? rows<Message>(
        db,
        'SELECT kind, text, response, created_at FROM op_consultation_messages WHERE thread_id = ? ORDER BY id',
        thread.id,
      )
    : [];
  const currentRevisions = messages.some(({ kind }) => kind === 'answer')
    ? currentCitationRevisions(ctx)
    : new Map<string, ReadonlySet<number>>();
  const link = thread
    ? '/consultation?' +
      new URLSearchParams({
        id: thread.id,
        ...(queue
          ? {
              view: inbox ? 'inbox' : 'archive',
              ...(status && status !== 'all' ? { status } : {}),
            }
          : {}),
      })
    : '/consultation';
  const hiddenThread = thread
    ? `<input type="hidden" name="id" value="${h(thread.id)}">`
    : '';
  const staffState = (row: Thread, state: string) =>
    (inbox && statuses.find((item) => item.id === state)?.label) ||
    threadLabels[row.status];
  const selected = thread && indexed.find(({ row }) => row.id === thread.id);
  const listLink =
    queue && thread
      ? '/consultation?view=' +
        (inbox ? 'inbox' : 'archive') +
        (status === 'all' ? '' : '&amp;status=' + encodeURIComponent(status))
      : '#consultation-history';
  return `<div class="workspace-heading"><div><h1>${inbox ? '상담 관리' : archive ? '완료된 상담' : '학원 상담'}</h1></div><div class="actions consult-heading-actions">${actorIsStaff ? '<a class="button-link subtle-link" href="/student-reports">교사용 상담 자료</a>' : ''}<a class="consultation-history-jump" href="${listLink}">${queue && thread ? '목록으로' : '상담 목록'}</a>${own && thread ? '<a class="button-link subtle-link" href="/consultation">새 상담</a>' : ''}</div></div>
    <div class="split consultation-layout" data-has-thread="${!!thread}" data-consultation-view="${queue ? 'queue' : 'conversation'}">
      <aside class="consultation-history" id="consultation-history" tabindex="-1">
        <h2>상담 목록</h2>
        ${actorIsStaff ? `<nav class="view-tabs" aria-label="상담 목록 범위"><a href="/consultation?view=inbox"${inbox ? ' aria-current="page"' : ''}>처리 중</a><a href="/consultation?view=archive"${archive ? ' aria-current="page"' : ''}>완료</a></nav>` : ''}
        ${
          queue
            ? `<nav class="consultation-status-links" aria-label="상담 상태">${statuses
                .filter((s) => inbox || s.id === 'all' || s.id === 'validation')
                .map(
                  ({ id: key, label }) =>
                    `<a class="workspace-link" href="/consultation?view=${inbox ? 'inbox' : 'archive'}&amp;status=${key}"${key === status ? ' aria-current="page"' : ''}>${label}</a>`,
                )
                .join('')}</nav>`
            : ''
        }
        ${
          threads.length
            ? `<ul class="item-list">${threads
                .map(({ row, detail, state }) => {
                  const body = queue
                    ? `<span class="consultation-row-heading"><strong>${h(participantLabel(detail))}</strong><span class="pill consultation-status" data-state="${h(inbox ? state : 'closed')}">${h(staffState(row, state))}</span></span><span class="consultation-preview">${h(inbox && state === 'waiting' ? detail.latestNote : detail.question)}</span><small>${inquiryTime(detail.receivedAt)}</small>`
                    : `<span>${h(row.status === 'open' ? row.title : detail.question)}</span><small>${h(threadLabels[row.status])} · ${h(participantLabel(detail))}</small>`;
                  return `<li><a href="/consultation?id=${encodeURIComponent(row.id)}${filter}#conversation"${row.id === id ? ' aria-current="page"' : ''}>${body}</a></li>`;
                })
                .join('')}</ul>`
            : `<p class="muted">${inbox ? '이 상태의 상담이 없습니다.' : archive ? '완료된 상담이 없습니다.' : '저장된 상담이 없습니다.'}</p>`
        }
      </aside>
      <section class="consultation-main" id="conversation" tabindex="-1">
        ${
          thread
            ? queue && selected
              ? `<div class="thread-heading staff-thread-heading"><div><h2>${h(participantLabel(selected.detail))}</h2><p>${inquiryTime(selected.detail.receivedAt)}</p></div><span class="pill consultation-status" data-state="${h(inbox ? selected.state : 'closed')}">${h(staffState(thread, selected.state))}</span></div>`
              : `<div class="thread-heading"><h2>${h(thread.title)}</h2><span class="pill">${h(threadLabels[thread.status])}</span></div>`
            : inbox || archive
              ? `<h2>${inbox ? '처리 중인 상담' : '완료된 상담'}</h2>${threads.length ? '<p class="muted">목록에서 상담을 선택해 주세요.</p>' : '<p class="muted">현재 목록이 비어 있습니다.</p>'}`
              : `<div class="consultation-welcome"><img src="/assets/owl.png" alt=""><div><h2>무엇이 궁금하세요?</h2><p>학원에서 확인한 자료로 답변해 드립니다.</p></div></div><div class="question-suggestions" aria-label="자주 묻는 질문">${suggestions.map((q) => `<button type="button" class="secondary" data-question="${h(q)}">${h(q)}<span aria-hidden="true">›</span></button>`).join('')}</div>`
        }
        <div class="conversation-messages">${messages.map((message) => renderMessage(message, currentRevisions)).join('')}</div>
        ${
          own && thread?.status !== 'closed' && (thread || !queue)
            ? `<form data-jump-label="질문 쓰기" class="chat-composer" method="post" action="${h(link)}">
          ${hiddenThread}<input type="hidden" name="conversationId" value="${thread?.id ?? randomUUID()}">
          <label class="compose-question"><span>질문</span><textarea name="question" rows="2" maxlength="500" required placeholder="${active ? '담당자에게 전할 내용을 입력하세요' : thread ? '이어서 궁금한 점을 입력하세요' : '학원에 궁금한 점을 입력하세요'}">${!thread ? h((url.searchParams.get('q') ?? '').slice(0, 500)) : ''}</textarea></label>
          <div class="compose-actions">${!active && actor.role === 'guardian' && students.length ? `<label>대상 학생 <select name="studentId"><option value="">선택 사항</option>${students.map(({ id, name }) => `<option value="${h(id)}">${h(name)}</option>`).join('')}</select></label>` : ''}
          <button name="action" value="ask">${active ? '담당자에게 보내기' : '질문 보내기'} <span aria-hidden="true">↑</span></button></div>
          <p class="chat-progress" role="status" aria-live="polite"></p>
        </form>`
            : ''
        }
        ${own && thread?.status === 'open' ? `<form class="actions" method="post">${hiddenThread}<button class="secondary" name="action" value="handoff">담당자 상담 요청</button></form>` : ''}
        ${own && thread?.status === 'requested' ? `<form class="actions" method="post">${hiddenThread}<button class="secondary" name="action" value="resume">요청 취소하고 AI 상담 계속</button></form>` : ''}
        ${
          active && actor.role === 'admin'
            ? `<form class="actions" method="post">
          ${hiddenThread}<label>담당자 <select name="assignee" required>${eligibleAssignees(
            ctx,
            thread,
          )
            .map(
              ({ id, name }) =>
                `<option value="${h(id)}"${thread.assignee_id === id ? ' selected' : ''}>${h(name)}</option>`,
            )
            .join('')}</select></label>
          <button name="action" value="assign">배정</button>
        </form>`
            : ''
        }
        ${
          staff
            ? `<form method="post">
          ${hiddenThread}<label>담당자 답변 <textarea name="text" maxlength="1000" rows="3"></textarea></label>
          <div class="actions"><button name="action" value="reply">답변 보내기</button><button class="secondary" name="action" value="close">상담 완료</button></div>
        </form>`
            : ''
        }
      </section>
    </div>`;
}

export const consultationModule: OperationModule = {
  path: '/consultation',
  label: '학원 상담',
  roles: ['guardian', 'student', 'teacher', 'admin'],
  setup: setupConsultation,
  render: renderConsultation,
  submit: submitConsultation,
};
