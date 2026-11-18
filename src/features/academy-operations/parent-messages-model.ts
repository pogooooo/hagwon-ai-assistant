import { createHash, randomUUID } from 'node:crypto';
import type { OperationsDatabase } from './database.ts';
import { accessibleStudents } from './directory.ts';
import { learningEvidence } from './learning.ts';
import { workbookEvidence } from './workbook-publication.ts';
import {
  DEFAULT_PARENT_TEMPLATE,
  fillParentTemplate,
  validateParentTemplate,
} from './parent-message-template.ts';
import {
  one,
  rows,
  transaction,
  OperationError,
  type PageContext,
} from './shared.ts';

export interface ParentPolicy {
  academy_id: string;
  version: number;
  enabled: number;
  automatic: number;
  day: number;
  hour: number;
  class_id: string;
  template: string;
}
export interface ParentMessage {
  id: string;
  academy_id: string;
  batch_id: string;
  guardian_id: string;
  student_id: string;
  kind: 'monthly' | 'notice';
  period: string;
  title: string;
  body: string;
  fingerprint: string;
  sources: string;
  state: 'draft' | 'queued' | 'delivered' | 'cancelled';
  scheduled_at: string;
  created_at: string;
  delivered_at: string | null;
  read_at: string | null;
  target_class_id?: string;
}
export function setupParentMessages(db: OperationsDatabase) {
  db.exec(`CREATE TABLE IF NOT EXISTS op_parent_policies (
    academy_id TEXT PRIMARY KEY,version INTEGER NOT NULL,enabled INTEGER NOT NULL DEFAULT 0,automatic INTEGER NOT NULL DEFAULT 0,
    day INTEGER NOT NULL DEFAULT 5,hour INTEGER NOT NULL DEFAULT 10,class_id TEXT NOT NULL DEFAULT '',template TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS op_parent_messages (
    id TEXT PRIMARY KEY,academy_id TEXT NOT NULL,batch_id TEXT NOT NULL,guardian_id TEXT NOT NULL,student_id TEXT NOT NULL,
    kind TEXT NOT NULL,period TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,fingerprint TEXT NOT NULL,sources TEXT NOT NULL,
    state TEXT NOT NULL,scheduled_at TEXT NOT NULL,created_at TEXT NOT NULL,delivered_at TEXT,read_at TEXT,target_class_id TEXT NOT NULL DEFAULT '');
    CREATE UNIQUE INDEX IF NOT EXISTS op_parent_monthly_once ON op_parent_messages(academy_id,period,student_id,guardian_id) WHERE kind='monthly';
    CREATE UNIQUE INDEX IF NOT EXISTS op_parent_notice_once ON op_parent_messages(academy_id,batch_id,student_id,guardian_id);
    CREATE INDEX IF NOT EXISTS op_parent_inbox ON op_parent_messages(academy_id,guardian_id,state,delivered_at);
    CREATE TABLE IF NOT EXISTS op_parent_runs(academy_id TEXT NOT NULL,period TEXT NOT NULL,version INTEGER NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(academy_id,period));`);
  if (
    !rows<{ name: string }>(db, 'PRAGMA table_info(op_parent_messages)').some(
      (c) => c.name === 'target_class_id',
    )
  )
    db.exec(
      "ALTER TABLE op_parent_messages ADD COLUMN target_class_id TEXT NOT NULL DEFAULT ''",
    );
}
export function parentPolicy(
  db: OperationsDatabase,
  academy: string,
): ParentPolicy {
  return (
    one<ParentPolicy>(
      db,
      'SELECT * FROM op_parent_policies WHERE academy_id=?',
      academy,
    ) ?? {
      academy_id: academy,
      version: 0,
      enabled: 0,
      automatic: 0,
      day: 5,
      hour: 10,
      class_id: '',
      template: DEFAULT_PARENT_TEMPLATE,
    }
  );
}
export const assertParentAdmin = (ctx: PageContext) => {
  ctx.assertCurrentAccess?.();
  if (ctx.actor.role !== 'admin')
    throw new OperationError('관리자 권한이 필요합니다.', 403);
};
export function saveParentPolicy(
  ctx: PageContext,
  value: Omit<ParentPolicy, 'academy_id'>,
) {
  assertParentAdmin(ctx);
  validateParentTemplate(value.template);
  if (
    ![value.day, value.hour, value.version].every(Number.isSafeInteger) ||
    value.day < 1 ||
    value.day > 28 ||
    value.hour < 8 ||
    value.hour > 20 ||
    ![0, 1].includes(value.enabled) ||
    ![0, 1].includes(value.automatic)
  )
    throw new OperationError('발송 날짜와 시간을 확인해 주세요.');
  if (
    value.class_id &&
    !one(
      ctx.db,
      'SELECT id FROM classes WHERE academy_id=? AND id=?',
      ctx.actor.academyId,
      value.class_id,
    )
  )
    throw new OperationError('대상 반을 확인해 주세요.', 403);
  transaction(ctx.db, () => {
    if (parentPolicy(ctx.db, ctx.actor.academyId).version !== value.version)
      throw new OperationError('설정이 변경됐습니다. 새로 열어 주세요.', 409);
    ctx.db
      .prepare(
        'INSERT INTO op_parent_policies VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(academy_id) DO UPDATE SET version=excluded.version,enabled=excluded.enabled,automatic=excluded.automatic,day=excluded.day,hour=excluded.hour,class_id=excluded.class_id,template=excluded.template',
      )
      .run(
        ctx.actor.academyId,
        value.version + 1,
        value.enabled,
        value.automatic,
        value.day,
        value.hour,
        value.class_id,
        value.template,
      );
  });
}
const hash = (v: unknown) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex');
const month = (period: string) => {
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(period))
    throw new OperationError('분석 월을 확인해 주세요.');
  return period;
};
export function previousReportMonth(now: number) {
  const d = new Date(now + 9 * 3600000);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}
export function monthlyEvidence(db: OperationsDatabase, academy: string) {
  const a = learningEvidence(db, academy),
    b = workbookEvidence(db, academy);
  return {
    documents: [...a.documents, ...b.documents],
    facts: [...a.facts, ...b.facts],
  };
}
export function monthlyReport(
  db: OperationsDatabase,
  academy: string,
  student: string,
  period: string,
  evidence = monthlyEvidence(db, academy),
) {
  month(period);
  const memberships = new Set(
    rows<{ class_id: string }>(
      db,
      'SELECT class_id FROM student_class_memberships WHERE academy_id=? AND student_id=? AND ended_at IS NULL',
      academy,
      student,
    ).map((r) => r.class_id),
  );
  const records = evidence.documents
    .filter(
      (d) =>
        d.academyId === academy &&
        d.studentId === student &&
        d.classId &&
        memberships.has(d.classId),
    )
    .flatMap((d) => {
      const facts = evidence.facts.filter(
        (f) =>
          f.academyId === academy &&
          f.documentId === d.documentId &&
          f.revision === d.revision &&
          f.subjectId === student &&
          f.period === period &&
          f.approvalStatus === 'approved' &&
          f.value.kind === 'accuracy' &&
          f.value.dimension === 'overall',
      );
      return facts.flatMap((f) => {
        const v = f.value;
        if (
          v.kind !== 'accuracy' ||
          !Number.isSafeInteger(v.total) ||
          !Number.isSafeInteger(v.correct) ||
          v.total <= 0 ||
          v.correct < 0 ||
          v.correct > v.total
        )
          return [];
        const klass =
          one<{ name: string }>(
            db,
            'SELECT name FROM classes WHERE academy_id=? AND id=?',
            academy,
            d.classId!,
          )?.name ?? '수강 반';
        return [
          {
            id: d.documentId,
            revision: d.revision,
            title: d.title,
            classId: d.classId!,
            text: d.text,
            fact: f,
            summary: `${klass} · ${d.documentId.startsWith('workbook-') ? '교재 숙제' : '분류 숙제'}\n확인된 ${v.total}문항 중 ${v.correct}문항 정답 (${Math.round((v.correct / v.total) * 100)}%).`,
          },
        ];
      });
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  if (!records.length) return null;
  return {
    fingerprint: hash(records),
    summary:
      records.map((r) => r.summary).join('\n\n') +
      '\n\n확인·승인된 결과만 포함합니다. 항목별 집계는 서로 합산하지 않습니다.',
    sources: records.map((r) => ({
      documentId: r.id,
      revision: r.revision,
      title: r.title,
    })),
  };
}
function recipients(db: OperationsDatabase, academy: string, classId = '') {
  if (
    classId &&
    !one(
      db,
      'SELECT id FROM classes WHERE academy_id=? AND id=?',
      academy,
      classId,
    )
  )
    throw new OperationError('대상 반을 확인해 주세요.', 403);
  const list = rows<{ guardian: string; student: string; name: string }>(
    db,
    `SELECT DISTINCT a.id AS guardian,s.id AS student,s.name FROM accounts a
    JOIN guardian_students g ON g.guardian_id=a.id JOIN students s ON s.id=g.student_id AND s.academy_id=a.academy_id
    WHERE a.academy_id=? AND a.role='guardian' AND EXISTS(SELECT 1 FROM student_class_memberships m WHERE m.academy_id=s.academy_id AND m.student_id=s.id AND m.ended_at IS NULL AND (?='' OR m.class_id=?)) ORDER BY s.id,a.id`,
    academy,
    classId,
    classId,
  );
  if (list.length > 1000)
    throw new OperationError(
      '한 번에 최대 1,000명의 수신 대상을 처리할 수 있습니다.',
      422,
    );
  return list;
}
function isRecipient(db: OperationsDatabase, m: ParentMessage) {
  if (
    m.target_class_id &&
    !one(
      db,
      'SELECT student_id FROM student_class_memberships WHERE academy_id=? AND class_id=? AND student_id=? AND ended_at IS NULL',
      m.academy_id,
      m.target_class_id,
      m.student_id,
    )
  )
    return false;
  return !!one(
    db,
    `SELECT a.id FROM accounts a JOIN guardian_students g ON g.guardian_id=a.id
    JOIN students s ON s.id=g.student_id AND s.academy_id=a.academy_id WHERE a.id=? AND a.academy_id=? AND a.role='guardian' AND s.id=? AND EXISTS(SELECT 1 FROM student_class_memberships m WHERE m.academy_id=s.academy_id AND m.student_id=s.id AND m.ended_at IS NULL)`,
    m.guardian_id,
    m.academy_id,
    m.student_id,
  );
}
export function messageCurrent(
  db: OperationsDatabase,
  m: ParentMessage,
  evidence?: ReturnType<typeof monthlyEvidence>,
) {
  return (
    isRecipient(db, m) &&
    (m.kind !== 'monthly' ||
      monthlyReport(db, m.academy_id, m.student_id, m.period, evidence)
        ?.fingerprint === m.fingerprint)
  );
}
// INSERT has explicit columns so migrations can add fields without shifting values.
function store(db: OperationsDatabase, m: ParentMessage) {
  return Number(
    db
      .prepare(
        `INSERT OR IGNORE INTO op_parent_messages(id,academy_id,batch_id,guardian_id,student_id,kind,period,title,body,fingerprint,sources,state,scheduled_at,created_at,delivered_at,read_at,target_class_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        m.id,
        m.academy_id,
        m.batch_id,
        m.guardian_id,
        m.student_id,
        m.kind,
        m.period,
        m.title,
        m.body,
        m.fingerprint,
        m.sources,
        m.state,
        m.scheduled_at,
        m.created_at,
        m.delivered_at,
        m.read_at,
        m.target_class_id ?? '',
      ).changes,
  );
}
export function prepareMonthlyMessages(
  db: OperationsDatabase,
  academy: string,
  period: string,
  policy: ParentPolicy,
  now = Date.now(),
  refreshDrafts = false,
) {
  return transaction(db, () =>
    buildMonthlyMessages(
      db,
      academy,
      period,
      policy,
      now,
      refreshDrafts ? 'refresh' : 'keep',
    ),
  );
}

function buildMonthlyMessages(
  db: OperationsDatabase,
  academy: string,
  period: string,
  policy: ParentPolicy,
  now: number,
  mode: 'keep' | 'refresh' | 'adopt',
) {
  month(period);
  validateParentTemplate(policy.template);
  const list = recipients(db, academy, policy.class_id),
    evidence = monthlyEvidence(db, academy),
    batch = `monthly:${academy}:${period}${mode === 'refresh' ? ':' + randomUUID() : ''}`;
  const academyName =
    one<{ name: string }>(db, 'SELECT name FROM academies WHERE id=?', academy)
      ?.name ?? '학원';
  let created = 0,
    missing = 0;
  const eligibleIds: string[] = [];
  for (const r of list) {
    const report = monthlyReport(db, academy, r.student, period, evidence);
    if (!report) {
      missing++;
      continue;
    }
    if (mode === 'refresh')
      db.prepare(
        "DELETE FROM op_parent_messages WHERE academy_id=? AND kind='monthly' AND period=? AND student_id=? AND guardian_id=? AND state IN('draft','cancelled')",
      ).run(academy, period, r.student, r.guardian);
    const message: ParentMessage = {
      id: randomUUID(),
      academy_id: academy,
      batch_id: batch,
      guardian_id: r.guardian,
      target_class_id: policy.class_id,
      student_id: r.student,
      kind: 'monthly',
      period,
      title: `${r.name} · ${period} 월간 학습 리포트`,
      body: fillParentTemplate(policy.template, {
        학생명: r.name,
        학원명: academyName,
        분석월: period,
        학습요약: report.summary,
      }),
      fingerprint: report.fingerprint,
      sources: JSON.stringify(report.sources),
      state: 'draft',
      scheduled_at: new Date(now).toISOString(),
      created_at: new Date(now).toISOString(),
      delivered_at: null,
      read_at: null,
    };
    const previous =
      mode === 'adopt'
        ? one<ParentMessage>(
            db,
            "SELECT * FROM op_parent_messages WHERE academy_id=? AND kind='monthly' AND period=? AND student_id=? AND guardian_id=?",
            academy,
            period,
            r.student,
            r.guardian,
          )
        : undefined;
    if (previous?.state === 'draft') {
      // A preview is the same monthly delivery, not a separate send. Refresh
      // its current evidence while preserving its existing preview/history URL.
      db.prepare(
        "UPDATE op_parent_messages SET target_class_id=?,title=?,body=?,fingerprint=?,sources=?,scheduled_at=? WHERE id=? AND state='draft'",
      ).run(
        policy.class_id,
        message.title,
        message.body,
        message.fingerprint,
        message.sources,
        message.scheduled_at,
        previous.id,
      );
      eligibleIds.push(previous.id);
    } else {
      const inserted = store(db, message);
      created += inserted;
      if (inserted) eligibleIds.push(message.id);
    }
  }
  return { batch, created, missing, recipients: list.length, eligibleIds };
}
export function createParentNotice(
  ctx: PageContext,
  value: {
    requestId: string;
    title: string;
    template: string;
    classId: string;
    scheduledAt: string;
  },
) {
  assertParentAdmin(ctx);
  validateParentTemplate(value.template, false);
  if (
    !/^[\w-]{16,100}$/.test(value.requestId) ||
    !value.title.trim() ||
    value.title.length > 100 ||
    !Number.isFinite(Date.parse(value.scheduledAt))
  )
    throw new OperationError('제목 또는 발송 일시를 확인해 주세요.');
  const targets = recipients(ctx.db, ctx.actor.academyId, value.classId),
    batch = 'notice:' + value.requestId;
  const academy =
    one<{ name: string }>(
      ctx.db,
      'SELECT name FROM academies WHERE id=?',
      ctx.actor.academyId,
    )?.name ?? '학원';
  if (!targets.length)
    throw new OperationError('연결된 학부모 계정이 없습니다.', 422);
  transaction(ctx.db, () => {
    for (const r of targets)
      store(ctx.db, {
        id: randomUUID(),
        academy_id: ctx.actor.academyId,
        batch_id: batch,
        guardian_id: r.guardian,
        target_class_id: value.classId,
        student_id: r.student,
        kind: 'notice',
        period: '',
        title: value.title,
        body: fillParentTemplate(value.template, {
          학생명: r.name,
          학원명: academy,
          분석월: '',
          학습요약: '',
        }),
        fingerprint: '',
        sources: '[]',
        state: 'draft',
        scheduled_at: new Date(value.scheduledAt).toISOString(),
        created_at: new Date().toISOString(),
        delivered_at: null,
        read_at: null,
      });
  });
  return batch;
}
export function queueParentBatch(ctx: PageContext, batch: string) {
  assertParentAdmin(ctx);
  transaction(ctx.db, () => {
    const messages = rows<ParentMessage>(
      ctx.db,
      "SELECT * FROM op_parent_messages WHERE academy_id=? AND batch_id=? AND state='draft'",
      ctx.actor.academyId,
      batch,
    );
    if (!messages.length)
      throw new OperationError('발송할 초안이 없습니다.', 409);
    const evidence = messages.some((m) => m.kind === 'monthly')
      ? monthlyEvidence(ctx.db, ctx.actor.academyId)
      : undefined;
    if (messages.some((m) => !messageCurrent(ctx.db, m, evidence)))
      throw new OperationError(
        '수신 대상 또는 학습 결과가 변경되었습니다. 리포트를 다시 확인해 주세요.',
        409,
      );
    ctx.db
      .prepare(
        "UPDATE op_parent_messages SET state='queued' WHERE academy_id=? AND batch_id=? AND state='draft'",
      )
      .run(ctx.actor.academyId, batch);
  });
  deliverParentMessages(ctx.db, Date.now());
}
export function deliverParentMessages(db: OperationsDatabase, now: number) {
  let delivered = 0;
  transaction(db, () => {
    const evidenceByAcademy = new Map<
      string,
      ReturnType<typeof monthlyEvidence>
    >();
    for (const m of rows<ParentMessage>(
      db,
      "SELECT * FROM op_parent_messages WHERE state='queued' AND scheduled_at<=? ORDER BY scheduled_at LIMIT 1000",
      new Date(now).toISOString(),
    )) {
      if (m.kind === 'monthly' && !evidenceByAcademy.has(m.academy_id))
        evidenceByAcademy.set(m.academy_id, monthlyEvidence(db, m.academy_id));
      if (!messageCurrent(db, m, evidenceByAcademy.get(m.academy_id))) {
        db.prepare(
          "UPDATE op_parent_messages SET state='cancelled' WHERE id=? AND state='queued'",
        ).run(m.id);
        continue;
      }
      delivered += Number(
        db
          .prepare(
            "UPDATE op_parent_messages SET state='delivered',delivered_at=? WHERE id=? AND state='queued'",
          )
          .run(new Date(now).toISOString(), m.id).changes,
      );
    }
  });
  return delivered;
}
export function runParentMessageJobs(
  db: OperationsDatabase,
  now = Date.now(),
  onPolicyError: (academyId: string) => void = () =>
    console.error('AXR parent report preparation failed; policy will retry.'),
) {
  const kst = new Date(now + 9 * 3600000),
    period = previousReportMonth(now);
  for (const p of rows<ParentPolicy>(
    db,
    'SELECT * FROM op_parent_policies WHERE enabled=1',
  )) {
    if (
      kst.getUTCDate() < p.day ||
      (kst.getUTCDate() === p.day && kst.getUTCHours() < p.hour)
    )
      continue;
    try {
      transaction(db, () => {
        const completed = one(
          db,
          'SELECT period FROM op_parent_runs WHERE academy_id=? AND period=?',
          p.academy_id,
          period,
        );
        // Enabling automatic delivery must also pick up an existing preview.
        // Previously delivered or explicitly cancelled messages are never reset.
        if (
          completed &&
          !(
            p.automatic &&
            one(
              db,
              "SELECT id FROM op_parent_messages WHERE academy_id=? AND period=? AND kind='monthly' AND state='draft' LIMIT 1",
              p.academy_id,
              period,
            )
          )
        )
          return;
        const result = buildMonthlyMessages(
          db,
          p.academy_id,
          period,
          p,
          now,
          p.automatic ? 'adopt' : 'keep',
        );
        if (p.automatic)
          db.prepare(
            "UPDATE op_parent_messages SET state='queued' WHERE academy_id=? AND state='draft' AND id IN (SELECT value FROM json_each(?))",
          ).run(p.academy_id, JSON.stringify(result.eligibleIds));
        // Late-approved reports can be picked up on the next tick. Unique message
        // keys prevent repeats after a restart or a crash between these writes.
        if (result.recipients && result.missing === 0)
          db.prepare(
            'INSERT OR IGNORE INTO op_parent_runs VALUES(?,?,?,?)',
          ).run(p.academy_id, period, p.version, new Date(now).toISOString());
      });
    } catch {
      onPolicyError(p.academy_id);
    }
  }
  return deliverParentMessages(db, now);
}
export function visibleParentMessages(ctx: PageContext) {
  if (!['admin', 'guardian'].includes(ctx.actor.role))
    throw new OperationError('알림을 볼 권한이 없습니다.', 403);
  const id = ctx.url.searchParams.get('id'),
    batch =
      ctx.actor.role === 'admin' ? ctx.url.searchParams.get('batch') : null;
  return rows<ParentMessage>(
    ctx.db,
    `SELECT * FROM op_parent_messages WHERE academy_id=? ${ctx.actor.role === 'guardian' ? "AND guardian_id=? AND state='delivered'" : ''} ${id ? 'AND id=?' : batch ? 'AND batch_id=?' : ''} ORDER BY created_at DESC,id DESC LIMIT ${batch ? 1000 : 200}`,
    ctx.actor.academyId,
    ...(ctx.actor.role === 'guardian' ? [ctx.actor.id] : []),
    ...(id ? [id] : batch ? [batch] : []),
  ).filter((m) => ctx.actor.role === 'admin' || isRecipient(ctx.db, m));
}
export function unreadParentCount(ctx: PageContext) {
  if (ctx.actor.role !== 'guardian') return 0;
  const students = accessibleStudents(ctx.db, ctx.actor).map((s) => s.id);
  return rows<{ student_id: string }>(
    ctx.db,
    "SELECT student_id FROM op_parent_messages WHERE academy_id=? AND guardian_id=? AND state='delivered' AND read_at IS NULL",
    ctx.actor.academyId,
    ctx.actor.id,
  ).filter((m) => students.includes(m.student_id)).length;
}
/** Sample each batch so a large recent send cannot hide every older month. */
export function parentMessageHistory(ctx: PageContext) {
  assertParentAdmin(ctx);
  return rows<ParentMessage>(
    ctx.db,
    `WITH history AS (
    SELECT *,ROW_NUMBER() OVER(PARTITION BY batch_id ORDER BY created_at DESC,id DESC) AS sample_row
    FROM op_parent_messages WHERE academy_id=?)
    SELECT * FROM history WHERE sample_row<=5 ORDER BY created_at DESC,id DESC LIMIT 200`,
    ctx.actor.academyId,
  );
}
