import { createHash, randomUUID } from 'node:crypto';
import { InMemoryRagStore } from '../rag-consultation/server/index.ts';
import type {
  SourceDocumentInput,
  Visibility,
} from '../rag-consultation/server/types.ts';
import type { OperationsDatabase } from './database.ts';
import { accessibleClasses } from './directory.ts';
import {
  escapeHtml as h,
  field,
  required,
  one,
  rows,
  transaction,
  OperationError,
  type OperationModule,
  type PageContext,
} from './shared.ts';

export interface KnowledgeRecord {
  id: string;
  academy_id: string;
  topic: string;
  kind: 'registration';
  state: 'draft' | 'approved' | 'superseded' | 'revoked';
  title: string;
  question: string;
  body: string;
  provenance: string;
  visibility: Visibility;
  class_id: string | null;
  valid_from: string | null;
  valid_to: string | null;
  created_at: string;
  approved_at: string | null;
  version: number;
}
export function setupKnowledge(db: OperationsDatabase) {
  db.exec(`CREATE TABLE IF NOT EXISTS op_knowledge (
    id TEXT PRIMARY KEY, academy_id TEXT NOT NULL, topic TEXT NOT NULL, kind TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'draft', title TEXT NOT NULL, question TEXT NOT NULL,
    body TEXT NOT NULL, provenance TEXT NOT NULL, visibility TEXT NOT NULL DEFAULT 'staff_only',
    class_id TEXT, valid_from TEXT, valid_to TEXT, created_at TEXT NOT NULL, approved_at TEXT,
    version INTEGER NOT NULL DEFAULT 1);
    CREATE INDEX IF NOT EXISTS op_knowledge_scope ON op_knowledge(academy_id,state,topic);`);
}
export function requireAdmin(ctx: PageContext) {
  ctx.assertCurrentAccess?.();
  if (ctx.actor.role !== 'admin')
    throw new OperationError('원장만 확정할 수 있습니다.', 403);
}
export function dateInput(value: string, label: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value + 'T00:00:00Z')) ||
    new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value
  )
    throw new OperationError(label + ' 날짜를 확인해 주세요.');
  return value;
}
export function createKnowledgeDraft(
  ctx: PageContext,
  input: {
    kind: KnowledgeRecord['kind'];
    title: string;
    question: string;
    body: string;
    provenance: string;
    topic?: string;
  },
) {
  requireAdmin(ctx);
  const id = randomUUID();
  const topic =
    input.topic ??
    createHash('sha256')
      .update(normalizeRegistrationTopic(input.question))
      .digest('hex');
  ctx.db
    .prepare(
      `INSERT INTO op_knowledge(id,academy_id,topic,kind,title,question,body,provenance,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      ctx.actor.academyId,
      topic,
      input.kind,
      input.title,
      input.question,
      input.body,
      input.provenance,
      new Date().toISOString(),
    );
  return id;
}
export const normalizeRegistrationTopic = (value: string) =>
  value
    .normalize('NFKC')
    .trim()
    .replace(/[?!.。]+$/g, '')
    .replace(/\s/g, '')
    .toLowerCase();
export function knowledgeEvidence(
  db: OperationsDatabase,
  academyId: string,
  now = Date.now(),
): SourceDocumentInput[] {
  return rows<KnowledgeRecord>(
    db,
    "SELECT * FROM op_knowledge WHERE academy_id=? AND state='approved'",
    academyId,
  )
    .filter(
      (x) =>
        x.valid_from &&
        Date.parse(x.valid_from) <= now &&
        (!x.valid_to || now < Date.parse(x.valid_to)),
    )
    .map((x) => ({
      academyId,
      documentId: 'knowledge-' + x.id,
      revision: x.version,
      title: `${x.title} · ${x.provenance.replace(/\s*·\s*https?:\/\/\S+/g, '')} · 원장 확인 ${x.approved_at!.slice(0, 10)}`,
      documentType: 'academy_info',
      text: x.body,
      visibility: x.visibility,
      classId: x.class_id,
      validFrom: x.valid_from!,
      validTo: x.valid_to,
      approvedAt: x.approved_at,
    }));
}
export async function approveKnowledge(ctx: PageContext, form: FormData) {
  requireAdmin(ctx);
  const id = required(form, 'id', '자료', 40);
  const from =
    dateInput(required(form, 'from', '적용 시작일'), '적용 시작일') +
    'T00:00:00+09:00';
  const until = dateInput(
    required(form, 'until', '적용 종료일'),
    '적용 종료일',
  );
  const to = new Date(
    Date.parse(until + 'T00:00:00+09:00') + 86400000,
  ).toISOString();
  if (Date.parse(to) <= Date.parse(from))
    throw new OperationError('적용 기간을 확인해 주세요.');
  const visibility = field(form, 'visibility');
  if (!['academy_public', 'class_members', 'staff_only'].includes(visibility))
    throw new OperationError('공개 범위를 선택해 주세요.');
  const classId =
    visibility === 'class_members'
      ? required(form, 'classId', '반', 128)
      : null;
  if (
    classId &&
    !accessibleClasses(ctx.db, ctx.actor).some((c) => c.id === classId)
  )
    throw new OperationError('허용된 반을 선택해 주세요.', 403);
  const snapshot = one<KnowledgeRecord>(
    ctx.db,
    'SELECT * FROM op_knowledge WHERE id=? AND academy_id=?',
    id,
    ctx.actor.academyId,
  );
  if (
    !snapshot ||
    snapshot.state !== 'draft' ||
    snapshot.version !== Number(field(form, 'version'))
  )
    throw new OperationError('자료가 변경되었습니다.', 409);
  const preview: SourceDocumentInput = {
    academyId: ctx.actor.academyId,
    documentId: 'knowledge-' + id,
    revision: snapshot.version + 1,
    documentType: 'academy_info',
    title: snapshot.title,
    text: snapshot.body,
    visibility: visibility as Visibility,
    classId,
    validFrom: from,
    validTo: to,
    approvedAt: new Date().toISOString(),
  };
  const verification = await new InMemoryRagStore().upsertIndexedRevision({
    document: preview,
    facts: [],
    approve: true,
  });
  if (verification.status !== 'activated')
    throw new OperationError(
      '자료 안전성·색인 검증을 통과하지 못했습니다. 원문을 확인해 주세요.',
    );
  transaction(ctx.db, () => {
    requireAdmin(ctx);
    const record = one<KnowledgeRecord>(
      ctx.db,
      'SELECT * FROM op_knowledge WHERE id=? AND academy_id=?',
      id,
      ctx.actor.academyId,
    );
    if (
      !record ||
      record.state !== 'draft' ||
      record.version !== Number(field(form, 'version'))
    )
      throw new OperationError('자료가 변경되었습니다. 다시 열어 주세요.', 409);
    const previous = rows<KnowledgeRecord>(
      ctx.db,
      "SELECT * FROM op_knowledge WHERE academy_id=? AND topic=? AND state='approved'",
      ctx.actor.academyId,
      record.topic,
    ).filter(
      (x) =>
        Date.parse(x.valid_from!) < Date.parse(to) &&
        (!x.valid_to || Date.parse(x.valid_to) > Date.parse(from)),
    );
    const replacements = form
      .getAll('replace')
      .filter((v): v is string => typeof v === 'string');
    if (previous.some((x) => !replacements.includes(x.id + ':' + x.version)))
      throw new OperationError(
        '같은 주제의 기존 답변을 확인하고 교체 여부를 선택해 주세요.',
        409,
      );
    for (const old of previous) {
      // A future replacement keeps the preceding answer usable until the new start.
      ctx.db
        .prepare(
          'UPDATE op_knowledge SET state=?,valid_to=?,version=version+1 WHERE id=?',
        )
        .run(
          Date.parse(from) > Date.now() ? 'approved' : 'superseded',
          from,
          old.id,
        );
    }
    ctx.db
      .prepare(
        "UPDATE op_knowledge SET state='approved',visibility=?,class_id=?,valid_from=?,valid_to=?,approved_at=?,version=version+1 WHERE id=?",
      )
      .run(visibility, classId, from, to, new Date().toISOString(), id);
  });
}
export const knowledgeModule: OperationModule = {
  path: '/knowledge',
  label: '등록 정보 승인',
  roles: ['admin'],
  setup: setupKnowledge,
  render(ctx) {
    requireAdmin(ctx);
    const list = rows<KnowledgeRecord>(
      ctx.db,
      'SELECT * FROM op_knowledge WHERE academy_id=? ORDER BY created_at DESC',
      ctx.actor.academyId,
    );
    return `<div class="page-heading"><h1>등록 정보 승인</h1><p>원장 답변과 교육청 정보를 검토한 뒤 상담에 적용합니다.</p></div>${
      list
        .map(
          (x) =>
            `<section class="panel"><h2>${h(x.title)}</h2><p>${h({ draft: '확인 대기', approved: '승인', superseded: '교체됨', revoked: '철회' }[x.state])} · ${h(x.provenance)}</p><pre class="preserve">${h(x.body)}</pre>${
              x.state === 'draft'
                ? `<form method="post"><input type="hidden" name="id" value="${h(x.id)}"><input type="hidden" name="version" value="${x.version}"><div class="fields"><label>공개 범위<select name="visibility"><option value="staff_only">직원만</option><option value="academy_public">학원 이용자 공개</option><option value="class_members">해당 반</option></select></label><label>반<select name="classId">${accessibleClasses(
                    ctx.db,
                    ctx.actor,
                  )
                    .map(
                      (c) => `<option value="${h(c.id)}">${h(c.name)}</option>`,
                    )
                    .join(
                      '',
                    )}</select></label><label>적용 시작일<input type="date" name="from" required></label><label>적용 종료일<input type="date" name="until" required></label></div>${list
                    .filter(
                      (old) =>
                        old.topic === x.topic && old.state === 'approved',
                    )
                    .map(
                      (old) =>
                        `<label class="check-label"><input type="checkbox" name="replace" value="${h(old.id)}:${old.version}">기존 답변 교체 (${h(old.valid_from?.slice(0, 10))}): ${h(old.body)}</label>`,
                    )
                    .join(
                      '',
                    )}<button name="action" value="approve">검수 완료·승인</button></form>`
                : ''
            }${x.state === 'approved' ? `<form method="post"><input type="hidden" name="id" value="${h(x.id)}"><input type="hidden" name="version" value="${x.version}"><button class="secondary" name="action" value="revoke">상담 사용 철회</button></form>` : ''}</section>`,
        )
        .join('') ||
      '<p class="empty">교육청 정보를 불러오거나 담당자 상담에서 원장 답변을 저장해 주세요.</p>'
    }`;
  },
  async submit(ctx, form) {
    requireAdmin(ctx);
    if (field(form, 'action') === 'approve') await approveKnowledge(ctx, form);
    else if (field(form, 'action') === 'revoke') {
      if (
        !ctx.db
          .prepare(
            "UPDATE op_knowledge SET state='revoked',version=version+1 WHERE id=? AND academy_id=? AND state='approved' AND version=?",
          )
          .run(
            field(form, 'id'),
            ctx.actor.academyId,
            Number(field(form, 'version')),
          ).changes
      )
        throw new OperationError('자료가 변경되었습니다.', 409);
    } else throw new OperationError('지원하지 않는 작업입니다.');
  },
};
