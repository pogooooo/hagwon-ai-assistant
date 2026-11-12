import { previewDocument } from './document-preview.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import {
  readAcademiesDataset,
  toAcademyDocumentInput,
  toAcademyFactInput,
} from '../rag-consultation/server/adapters/fixture/load-academies.ts';
import {
  DEFAULT_RAG_CONFIG,
  InMemoryRagStore,
  type ApprovedFactInput,
  type DocumentType,
  type SourceDocumentInput,
  type Visibility,
} from '../rag-consultation/server/index.ts';
import { prepareFileDocument } from '../rag-consultation/server/ingest/ingest-file.ts';
import { DEFAULT_PARSE_LIMITS } from '../rag-consultation/server/ingest/parsers/types.ts';
import { validateDocument } from '../rag-consultation/server/ingest/validation.ts';
import { canReadRecord } from '../rag-consultation/server/retrieval/access-filter.ts';
import { accessibleClasses, accessibleStudents } from './directory.ts';
import {
  escapeHtml as h,
  field,
  one,
  OperationError,
  required,
  rows,
  transaction,
  type OperationModule,
  type PageContext,
} from './shared.ts';

export const maxDocumentBytes = DEFAULT_PARSE_LIMITS.maxBytes;
const demoDirectory = fileURLToPath(
  new URL('../makeup-schedule/academies/', import.meta.url),
);
const documentTypes: Record<DocumentType, string> = {
  academy_info: '학원 안내',
  fee: '수강료',
  schedule: '시간표',
  policy: '운영 규정',
  facility: '시설',
  teacher: '강사 안내',
  announcement: '공지',
  student_analysis: '확정 학습 자료',
  guidance: '지도 자료',
};
const visibilityLabels: Record<Visibility, string> = {
  academy_public: '학원 공개',
  class_members: '지정 반',
  student_private: '지정 학생과 담당자',
  staff_only: '교직원',
};
type DocumentState = 'draft' | 'published' | 'withdrawn';
interface DocumentVersion {
  input: SourceDocumentInput;
  facts: ApprovedFactInput[];
  state: DocumentState;
  originalName: string | null;
}
interface DocumentRow {
  document_id: string;
  revision: number;
  input: string;
  facts: string;
  state: DocumentState;
  original_name: string | null;
}

const indexCache = new WeakMap<
  DatabaseSync,
  Map<string, { version: string; store: Promise<InMemoryRagStore> }>
>();

function toVersion(row: DocumentRow): DocumentVersion {
  return {
    input: JSON.parse(row.input) as SourceDocumentInput,
    facts: JSON.parse(row.facts) as ApprovedFactInput[],
    state: row.state,
    originalName: row.original_name,
  };
}

function setupDocuments(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS op_document_versions (
      academy_id TEXT NOT NULL REFERENCES academies(id),
      document_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision > 0),
      input TEXT NOT NULL,
      facts TEXT NOT NULL DEFAULT '[]',
      state TEXT NOT NULL CHECK(state IN ('draft', 'published', 'withdrawn')),
      original_name TEXT,
      original_file BLOB,
      PRIMARY KEY (academy_id, document_id, revision)
    );
    CREATE TABLE IF NOT EXISTS op_document_index_generations (
      academy_id TEXT PRIMARY KEY REFERENCES academies(id),
      generation INTEGER NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS op_document_published_insert
      AFTER INSERT ON op_document_versions WHEN NEW.state = 'published'
    BEGIN
      INSERT INTO op_document_index_generations VALUES (NEW.academy_id, 1)
      ON CONFLICT (academy_id) DO UPDATE SET generation = generation + 1;
    END;
    CREATE TRIGGER IF NOT EXISTS op_document_published_update
      AFTER UPDATE ON op_document_versions
      WHEN OLD.state = 'published' OR NEW.state = 'published'
    BEGIN
      INSERT INTO op_document_index_generations VALUES (NEW.academy_id, 1)
      ON CONFLICT (academy_id) DO UPDATE SET generation = generation + 1;
      INSERT INTO op_document_index_generations
      SELECT OLD.academy_id, 1 WHERE OLD.academy_id <> NEW.academy_id
      ON CONFLICT (academy_id) DO UPDATE SET generation = generation + 1;
    END;
    CREATE TRIGGER IF NOT EXISTS op_document_published_delete
      AFTER DELETE ON op_document_versions WHEN OLD.state = 'published'
    BEGIN
      INSERT INTO op_document_index_generations VALUES (OLD.academy_id, 1)
      ON CONFLICT (academy_id) DO UPDATE SET generation = generation + 1;
    END;
  `);
  const dataset = readAcademiesDataset(demoDirectory);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO op_document_versions
      (academy_id, document_id, revision, input, facts, state)
    VALUES (?, ?, ?, ?, ?, 'published')
  `);
  transaction(db, () => {
    for (const document of dataset.documents) {
      if (document.meta.status !== 'approved_active') continue;
      const input = toAcademyDocumentInput(document);
      const facts = dataset.facts
        .filter(
          (fact) =>
            fact.document_id === input.documentId &&
            fact.revision === input.revision,
        )
        .map(toAcademyFactInput);
      insert.run(
        input.academyId,
        input.documentId,
        input.revision,
        JSON.stringify(input),
        JSON.stringify(facts),
      );
    }
  });
}

function academyVersions(db: DatabaseSync, academyId: string) {
  return rows<DocumentRow>(
    db,
    `SELECT document_id, revision, input, facts, state, original_name
     FROM op_document_versions WHERE academy_id = ?
     ORDER BY document_id, revision DESC`,
    academyId,
  ).map(toVersion);
}

function knownPublishedVersions(versions: DocumentVersion[], now: number) {
  return versions.filter(({ input, state }) => {
    const approvedAt = Date.parse(input.approvedAt ?? '');
    // Keep malformed published rows in the sequence to fail closed for older versions.
    return (
      state === 'published' &&
      (!Number.isFinite(approvedAt) || approvedAt <= now)
    );
  });
}

// Versions arrive newest first. A higher revision limits when an older
// revision can apply, even if the higher revision subsequently expires.
function applicableVersions(known: DocumentVersion[], now: number) {
  const earliestHigherStart = new Map<string, number>();
  return known.filter(({ input }) => {
    const { documentId } = input;
    const start = Date.parse(input.validFrom);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(Date.parse(input.approvedAt ?? ''))
    ) {
      earliestHigherStart.set(documentId, -Infinity);
      return false;
    }
    const next = earliestHigherStart.get(documentId) ?? Infinity;
    if (start >= next) return false;
    earliestHigherStart.set(documentId, start);
    const end = input.validTo ? Date.parse(input.validTo) : Infinity;
    return Math.max(start, now) < Math.min(end, next);
  });
}

function publishedGeneration(db: DatabaseSync, academyId: string) {
  return (
    one<{ generation: number }>(
      db,
      'SELECT generation FROM op_document_index_generations WHERE academy_id = ?',
      academyId,
    )?.generation ?? 0
  );
}

function scheduleVersion(
  documents: SourceDocumentInput[],
  facts: ApprovedFactInput[],
) {
  return createHash('sha256')
    .update(JSON.stringify([documents, facts]))
    .digest('hex');
}

export function documentsIndexVersion(
  db: DatabaseSync,
  academyId: string,
  extraDocuments: SourceDocumentInput[],
  extraFacts: ApprovedFactInput[],
) {
  return (
    publishedGeneration(db, academyId) +
    ':' +
    scheduleVersion(extraDocuments, extraFacts)
  );
}

async function createDocumentsIndex(
  db: DatabaseSync,
  academyId: string,
  extraDocuments: SourceDocumentInput[],
  extraFacts: ApprovedFactInput[],
) {
  const store = new InMemoryRagStore();
  const approved = rows<DocumentRow>(
    db,
    `SELECT document_id, revision, input, facts, state, original_name
     FROM op_document_versions
     WHERE academy_id = ? AND state = 'published'
     ORDER BY document_id, revision`,
    academyId,
  );
  for (const row of approved) {
    try {
      const { input, facts } = toVersion(row);
      if (
        input.academyId === academyId &&
        input.documentId === row.document_id &&
        input.revision === row.revision &&
        (
          await store.upsertIndexedRevision({
            document: input,
            facts,
            approve: true,
          })
        ).status === 'activated'
      )
        continue;
    } catch {
      // Previously published data can predate approval-time validation.
    }
    // A broken published revision may have narrowed access to its predecessor.
    // Disable that document until a later verified revision activates.
    await store.revokeRevision({
      academyId,
      documentId: row.document_id,
      reason: 'revoked',
    });
  }
  for (const input of extraDocuments) {
    if (input.academyId !== academyId) continue;
    await store.upsertIndexedRevision({
      document: input,
      facts: extraFacts.filter(
        (fact) =>
          fact.academyId === academyId &&
          fact.documentId === input.documentId &&
          fact.revision === input.revision,
      ),
      approve: true,
    });
  }
  return store;
}

export async function buildDocumentsIndex(
  db: DatabaseSync,
  academyId: string,
  extraDocuments: SourceDocumentInput[],
  extraFacts: ApprovedFactInput[],
) {
  const generation = publishedGeneration(db, academyId);
  const version =
    generation + ':' + scheduleVersion(extraDocuments, extraFacts);
  let academyIndexes = indexCache.get(db);
  if (!academyIndexes) {
    academyIndexes = new Map();
    indexCache.set(db, academyIndexes);
  }
  let cached = academyIndexes.get(academyId);
  if (!cached || cached.version !== version) {
    cached = {
      version,
      store: createDocumentsIndex(db, academyId, extraDocuments, extraFacts),
    };
    academyIndexes.set(academyId, cached);
  }
  try {
    const store = await cached.store;
    if (publishedGeneration(db, academyId) !== generation)
      throw new OperationError(
        '승인된 자료가 변경됐습니다. 다시 시도해 주세요.',
        409,
      );
    return store;
  } catch (error) {
    if (academyIndexes.get(academyId) === cached)
      academyIndexes.delete(academyId);
    throw error;
  }
}

function readablePublishedVersions({ db, actor }: PageContext) {
  const versions = academyVersions(db, actor.academyId);
  const now = Date.now();
  const known = knownPublishedVersions(versions, now);
  const studentIds = accessibleStudents(db, actor).map(({ id }) => id);
  const classIds = accessibleClasses(db, actor).map(({ id }) => id);
  const scope = {
    actorId: actor.id,
    academyId: actor.academyId,
    role: actor.role,
    allowedStudentIds: studentIds,
    allowedClassIds: classIds,
    studentRefs: accessibleStudents(db, actor).map((s) => ({
      studentId: s.id,
      displayLabel: s.name,
      aliases: [s.name],
      classIds: s.classIds,
    })),
    canViewPublicHistory: false,
  };
  const canRead = (input: SourceDocumentInput) =>
    Number.isFinite(Date.parse(input.approvedAt ?? '')) &&
    Number.isFinite(Date.parse(input.validFrom)) &&
    canReadRecord(
      scope,
      {
        ...input,
        studentId: input.studentId ?? null,
        classId: input.classId ?? null,
      },
      studentIds,
    );
  const readable = new Set<DocumentVersion>();
  const restricted = new Set<string>();
  for (const version of known) {
    const { input } = version;
    if (!canRead(input)) restricted.add(input.documentId);
    if (!restricted.has(input.documentId)) readable.add(version);
  }
  return applicableVersions(known, now).filter((version) =>
    readable.has(version),
  );
}

export function currentDocumentRevisions(
  ctx: PageContext,
): Map<string, ReadonlySet<number>> {
  const revisions = new Map<string, Set<number>>();
  for (const { input } of readablePublishedVersions(ctx)) {
    const current = revisions.get(input.documentId) ?? new Set<number>();
    current.add(input.revision);
    revisions.set(input.documentId, current);
  }
  return revisions;
}

function visibleVersions(ctx: PageContext): DocumentVersion[] {
  return ctx.actor.role === 'admin'
    ? academyVersions(ctx.db, ctx.actor.academyId)
    : readablePublishedVersions(ctx);
}

export function documentDownload(ctx: PageContext) {
  const id = ctx.url.searchParams.get('id');
  const revision = Number(ctx.url.searchParams.get('revision'));
  const document = visibleVersions(ctx).find(
    ({ input }) => input.documentId === id && input.revision === revision,
  );
  if (!document) throw new OperationError('자료를 찾을 수 없습니다.', 404);
  if (
    ctx.actor.role === 'admin' &&
    ctx.url.searchParams.get('original') === '1'
  ) {
    const original = one<{ original_file: Uint8Array | null }>(
      ctx.db,
      `SELECT original_file FROM op_document_versions
       WHERE academy_id = ? AND document_id = ? AND revision = ?`,
      ctx.actor.academyId,
      id,
      revision,
    );
    if (original?.original_file && document.originalName) {
      return { name: document.originalName, content: original.original_file };
    }
  }
  return {
    name: document.input.title + '.md',
    content: Buffer.from(document.input.text, 'utf8'),
  };
}

function selectedDocument(
  ctx: PageContext,
  versions: DocumentVersion[],
): DocumentVersion | undefined {
  const id = ctx.url.searchParams.get('id');
  const revision = Number(ctx.url.searchParams.get('revision'));
  return versions.find(
    ({ input }) => input.documentId === id && input.revision === revision,
  );
}

function options<T extends string>(values: Record<T, string>, selected?: T) {
  return (Object.entries(values) as [T, string][])
    .map(
      ([id, label]) =>
        `<option value="${h(id)}"${id === selected ? ' selected' : ''}>${h(label)}</option>`,
    )
    .join('');
}

function targetOptions(
  targets: { id: string; name: string }[],
  selected?: string | null,
) {
  return (
    '<option value="">선택 안 함</option>' +
    targets
      .map(
        ({ id, name }) =>
          `<option value="${h(id)}"${id === selected ? ' selected' : ''}>${h(name)}</option>`,
      )
      .join('')
  );
}

function localDateTime(value?: string | null) {
  if (!value) return '';
  return new Date(Date.parse(value) + 9 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 16);
}

function parseLocalDateTime(value: string) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
    throw new OperationError('날짜와 시간을 확인해 주세요.');
  }
  const date = Date.parse(value + ':00+09:00');
  if (
    !Number.isFinite(date) ||
    localDateTime(new Date(date).toISOString()) !== value
  ) {
    throw new OperationError('날짜와 시간을 확인해 주세요.');
  }
  return new Date(date).toISOString();
}

function revisionForm(ctx: PageContext, previous?: SourceDocumentInput) {
  const classes = accessibleClasses(ctx.db, ctx.actor);
  const students = accessibleStudents(ctx.db, ctx.actor);
  return `<section class="panel">
    <h2>${previous ? '새 개정판 작성' : '자료 등록'}</h2>
    <form method="post" action="/documents" enctype="multipart/form-data">
      <input type="hidden" name="action" value="save">
      ${
        previous
          ? `<input type="hidden" name="documentId" value="${h(previous.documentId)}">
        <input type="hidden" name="baseRevision" value="${previous.revision}">`
          : ''
      }
      <div class="fields">
        <label>제목 <input name="title" maxlength="200" required value="${h(previous?.title)}"></label>
        <label>자료 종류 <select name="documentType">${options(documentTypes, previous?.documentType)}</select></label>
        <label>공개 범위 <select name="visibility">${options(visibilityLabels, previous?.visibility)}</select></label>
        <label>대상 반 <select name="classId">${targetOptions(classes, previous?.classId)}</select></label>
        <label>대상 학생 <select name="studentId">${targetOptions(students, previous?.studentId)}</select></label>
        <label>적용 시작 (한국시간) <input type="datetime-local" name="validFrom" value="${h(localDateTime(previous?.validFrom))}"></label>
        <label>적용 종료 (한국시간) <input type="datetime-local" name="validTo" value="${h(localDateTime(previous?.validTo))}"></label>
        <label>파일 <input type="file" name="file" accept=".pdf,.docx,.hwpx,.txt,.md,.markdown"></label>
      </div>
      <label>직접 입력 또는 추출 내용 수정
        <textarea name="text" rows="7" maxlength="${DEFAULT_RAG_CONFIG.maxDocumentChars}">${h(previous?.text)}</textarea>
      </label>
      <p class="muted">파일을 선택하면 파일의 텍스트를 읽습니다. 파일 없이 내용만 입력할 수도 있습니다.</p>
      <button type="submit">검수 대기로 저장</button>
    </form>
  </section>`;
}

async function renderDocuments(ctx: PageContext) {
  const versions = visibleVersions(ctx);
  const selected = selectedDocument(ctx, versions);
  const admin = ctx.actor.role === 'admin';
  const canWithdraw =
    selected?.state === 'draft' ||
    (selected?.state === 'published' &&
      selected.input.revision ===
        latestPublishedRevision(
          ctx.db,
          ctx.actor.academyId,
          selected.input.documentId,
        ));
  const link = (input: SourceDocumentInput) =>
    `id=${encodeURIComponent(input.documentId)}&amp;revision=${input.revision}`;
  const now = Date.now();
  const activeIds = new Set(
    applicableVersions(knownPublishedVersions(versions, now), now)
      .filter(({ input }) => Date.parse(input.validFrom) <= now)
      .map(({ input }) => input.documentId + ':' + input.revision),
  );
  const search = (ctx.url.searchParams.get('q') ?? '').slice(0, 200).trim();
  const category = ctx.url.searchParams.get('category') ?? '';
  const filtered = versions.filter(
    ({ input }) =>
      (!category || input.documentType === category) &&
      (!search ||
        (input.title + ' ' + input.text)
          .toLocaleLowerCase()
          .includes(search.toLocaleLowerCase())),
  );
  const canPreview =
    selected &&
    ['admin', 'teacher'].includes(ctx.actor.role) &&
    activeIds.has(selected.input.documentId + ':' + selected.input.revision);
  const question = (ctx.url.searchParams.get('previewQuestion') ?? '').trim();
  const preview =
    canPreview && question
      ? await previewDocument(ctx, selected.input, selected.facts, question)
      : '';
  const list = filtered
    .map(({ input, state }) => {
      const label =
        state === 'draft'
          ? '검수 대기'
          : state === 'withdrawn'
            ? '철회'
            : activeIds.has(input.documentId + ':' + input.revision)
              ? '공개 중'
              : '승인됨';
      return `<tr><td><a href="/documents?${link(input)}">${h(input.title)}</a></td>
      <td>v${input.revision}</td><td>${h(visibilityLabels[input.visibility])}</td>
      <td>${h(label)}</td></tr>`;
    })
    .join('');
  return `<h1>학원 자료</h1>
    <section class="panel">
      <h2>자료 목록</h2><form class="document-filters" method="get"><label>자료 검색<input name="q" value="${h(search)}" maxlength="200" placeholder="제목 또는 본문"></label><label>분류<select name="category"><option value="">전체 분류</option>${Object.entries(
        documentTypes,
      )
        .map(
          ([id, label]) =>
            `<option value="${id}"${category === id ? ' selected' : ''}>${label}</option>`,
        )
        .join('')}</select></label><button>검색</button></form>
      ${list ? `<div class="table-wrap"><table><thead><tr><th>제목</th><th>개정</th><th>공개 범위</th><th>상태</th></tr></thead><tbody>${list}</tbody></table></div>` : '<p class="muted">열람할 수 있는 자료가 없습니다.</p>'}
    </section>
    ${
      selected
        ? `<section class="panel">
      <h2>${h(selected.input.title)} · v${selected.input.revision}</h2>
      ${selected.input.extraction?.warnings?.length ? `<p class="notice">검수 항목 ${h(selected.input.extraction.warnings.join(', '))}</p>` : ''}
      <pre class="preview">${h(selected.input.text)}</pre>${canPreview ? `<details class="panel" ${question ? 'open' : ''}><summary>이 자료로 답변 미리보기</summary><form method="get"><input type="hidden" name="id" value="${h(selected.input.documentId)}"><input type="hidden" name="revision" value="${selected.input.revision}"><label>질문<input name="previewQuestion" maxlength="500" required value="${h(question)}"></label><button>근거 확인</button></form>${preview}</details>` : ''}
      <div class="actions">
        <a href="/documents/download?${link(selected.input)}">확인한 텍스트 내려받기</a>
        ${admin && selected.originalName ? `<a href="/documents/download?${link(selected.input)}&amp;original=1">원본 파일 내려받기</a>` : ''}
      </div>
      ${
        admin && canWithdraw
          ? `<form class="actions" method="post">
        <input type="hidden" name="documentId" value="${h(selected.input.documentId)}">
        <input type="hidden" name="revision" value="${selected.input.revision}">
        ${selected.state === 'draft' ? '<button name="action" value="approve">내용 검수 후 승인</button>' : ''}
        <button class="secondary" name="action" value="withdraw">${selected.state === 'draft' ? '초안 철회' : '자료 공개 철회'}</button>
      </form>`
          : ''
      }
    </section>`
        : ''
    }
    ${admin ? revisionForm(ctx, selected?.input) : ''}`;
}

function latestRevision(db: DatabaseSync, academyId: string, id: string) {
  return (
    one<{ revision: number }>(
      db,
      `SELECT revision FROM op_document_versions
     WHERE academy_id = ? AND document_id = ? ORDER BY revision DESC LIMIT 1`,
      academyId,
      id,
    )?.revision ?? 0
  );
}

function latestPublishedRevision(
  db: DatabaseSync,
  academyId: string,
  id: string,
) {
  return one<{ revision: number }>(
    db,
    `SELECT revision FROM op_document_versions
     WHERE academy_id = ? AND document_id = ? AND state = 'published'
     ORDER BY revision DESC LIMIT 1`,
    academyId,
    id,
  )?.revision;
}

function requireScope(
  ctx: PageContext,
  input: Pick<
    SourceDocumentInput,
    'visibility' | 'classId' | 'studentId' | 'documentType'
  >,
) {
  const { db, actor } = ctx;
  if (
    (input.visibility === 'class_members' &&
      !accessibleClasses(db, actor).some(({ id }) => id === input.classId)) ||
    (input.visibility === 'student_private' &&
      !accessibleStudents(db, actor).some(
        ({ id }) => id === input.studentId,
      )) ||
    (input.documentType === 'student_analysis' &&
      input.visibility !== 'student_private')
  ) {
    throw new OperationError('공개 범위에 맞는 반 또는 학생을 지정해 주세요.');
  }
}

async function approveDocument(ctx: PageContext, version: DocumentVersion) {
  const { db, actor } = ctx;
  const { documentId, revision } = version.input;
  const checkDraft = () => {
    if (revision !== latestRevision(db, actor.academyId, documentId)) {
      throw new OperationError('최신 검수 대기 개정판을 선택해 주세요.', 409);
    }
  };
  if (version.state !== 'draft') {
    throw new OperationError('최신 검수 대기 개정판을 선택해 주세요.', 409);
  }
  checkDraft();
  const publishedRevision = latestPublishedRevision(
    db,
    actor.academyId,
    documentId,
  );
  const input = { ...version.input, approvedAt: new Date().toISOString() };
  const result = await new InMemoryRagStore().upsertIndexedRevision({
    document: input,
    facts: version.facts,
    approve: false,
  });
  if (result.status !== 'staged') {
    throw new OperationError(
      '자료를 검색에 사용할 수 없습니다. 본문과 적용 기간을 확인하고 새 개정판을 저장해 주세요.',
      422,
    );
  }
  transaction(db, () => {
    ctx.assertCurrentAccess?.();
    requireScope(ctx, input);
    checkDraft();
    if (
      latestPublishedRevision(db, actor.academyId, documentId) !==
      publishedRevision
    ) {
      throw new OperationError(
        '자료 공개 상태가 바뀌었습니다. 다시 확인해 주세요.',
        409,
      );
    }
    const updated = db
      .prepare(
        `UPDATE op_document_versions SET state = 'published', input = ?
       WHERE academy_id = ? AND document_id = ? AND revision = ? AND state = 'draft'`,
      )
      .run(JSON.stringify(input), actor.academyId, documentId, revision);
    if (!updated.changes) {
      throw new OperationError(
        '자료 상태가 변경됐습니다. 목록을 다시 열어 주세요.',
        409,
      );
    }
  });
}

async function submitDocument(ctx: PageContext, form: FormData) {
  const { db, actor } = ctx;
  ctx.assertCurrentAccess?.();
  if (actor.role !== 'admin')
    throw new OperationError('관리자 권한이 필요합니다.', 403);
  const action = field(form, 'action');
  const id = field(form, 'documentId', 128);
  if (action === 'approve' || action === 'withdraw') {
    const revision = Number(field(form, 'revision', 12));
    if (!Number.isSafeInteger(revision) || revision < 1)
      throw new OperationError('자료를 찾을 수 없습니다.', 404);
    const row = one<DocumentRow>(
      db,
      `SELECT document_id, revision, input, facts, state, original_name
       FROM op_document_versions WHERE academy_id = ? AND document_id = ? AND revision = ?`,
      actor.academyId,
      id,
      revision,
    );
    if (!row || row.state === 'withdrawn') {
      throw new OperationError('자료를 찾을 수 없습니다.', 404);
    }
    if (action === 'approve') {
      await approveDocument(ctx, toVersion(row));
      return;
    }
    transaction(db, () => {
      ctx.assertCurrentAccess?.();
      if (row.state === 'draft') {
        const updated = db
          .prepare(
            `UPDATE op_document_versions SET state = 'withdrawn'
           WHERE academy_id = ? AND document_id = ? AND revision = ? AND state = 'draft'`,
          )
          .run(actor.academyId, id, revision);
        if (!updated.changes) {
          throw new OperationError(
            '자료 상태가 변경됐습니다. 목록을 다시 열어 주세요.',
            409,
          );
        }
        return;
      }
      if (revision !== latestPublishedRevision(db, actor.academyId, id)) {
        throw new OperationError('최신 승인 개정판을 열어 철회해 주세요.', 409);
      }
      db.prepare(
        `UPDATE op_document_versions SET state = 'withdrawn'
         WHERE academy_id = ? AND document_id = ? AND state = 'published'`,
      ).run(actor.academyId, id);
    });
    return;
  }
  if (action !== 'save') throw new OperationError('지원하지 않는 요청입니다.');
  const latest = id ? latestRevision(db, actor.academyId, id) : 0;
  if (id && (!latest || Number(field(form, 'baseRevision')) !== latest)) {
    throw new OperationError('최신 개정판을 열어 수정해 주세요.', 409);
  }
  const documentType = field(form, 'documentType') as DocumentType;
  const visibility = field(form, 'visibility') as Visibility;
  if (
    !Object.hasOwn(documentTypes, documentType) ||
    !Object.hasOwn(visibilityLabels, visibility)
  ) {
    throw new OperationError('자료 종류와 공개 범위를 선택해 주세요.');
  }
  const classId =
    visibility === 'class_members' ? field(form, 'classId', 128) : null;
  const studentId =
    visibility === 'student_private' ? field(form, 'studentId', 128) : null;
  const meta = {
    academyId: actor.academyId,
    documentId: id || randomUUID(),
    revision: latest + 1,
    documentType,
    title: required(form, 'title', '제목', 200),
    visibility,
    classId,
    studentId,
    validFrom:
      parseLocalDateTime(field(form, 'validFrom', 20)) ??
      new Date().toISOString(),
    validTo: parseLocalDateTime(field(form, 'validTo', 20)),
  };
  requireScope(ctx, meta);
  const file = form.get('file');
  const original = file instanceof File && file.size ? file : null;
  if (original && original.size > maxDocumentBytes) {
    throw new OperationError('파일은 20MB 이하로 올려 주세요.');
  }
  const bytes = original
    ? new Uint8Array(await original.arrayBuffer())
    : Buffer.from(
        required(form, 'text', '내용', DEFAULT_RAG_CONFIG.maxDocumentChars),
        'utf8',
      );
  const prepared = await prepareFileDocument(
    meta,
    { bytes, fileName: original?.name ?? '직접입력.md' },
    { ocr: null },
  );
  if (!prepared.document) {
    throw new OperationError(
      '텍스트를 읽을 수 없습니다. 텍스트가 포함된 파일을 올리거나 확인한 내용을 입력해 주세요.',
    );
  }
  const input = prepared.document;
  if (!validateDocument(input, [], DEFAULT_RAG_CONFIG).ok) {
    throw new OperationError(
      '자료 내용, 공개 범위와 적용 기간을 확인해 주세요.',
    );
  }
  transaction(db, () => {
    ctx.assertCurrentAccess?.();
    requireScope(ctx, input);
    if (latestRevision(db, actor.academyId, meta.documentId) !== latest) {
      throw new OperationError(
        '다른 개정판이 먼저 저장됐습니다. 목록을 새로 열어 주세요.',
        409,
      );
    }
    db.prepare(
      `
      INSERT INTO op_document_versions
        (academy_id, document_id, revision, input, state, original_name, original_file)
      VALUES (?, ?, ?, ?, 'draft', ?, ?)
    `,
    ).run(
      actor.academyId,
      meta.documentId,
      meta.revision,
      JSON.stringify(input),
      original?.name ?? null,
      original ? bytes : null,
    );
  });
}

export const documentsModule: OperationModule = {
  path: '/documents',
  label: '학원 자료',
  roles: ['admin', 'teacher', 'student', 'guardian', 'visitor'],
  setup: setupDocuments,
  render: renderDocuments,
  submit: submitDocument,
};
