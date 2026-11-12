import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';

import type { SourceDocumentInput } from '../rag-consultation/server/index.ts';
import {
  buildDocumentsIndex,
  currentDocumentRevisions,
  documentDownload,
  documentsIndexVersion,
  documentsModule,
} from './documents.ts';
import { directoryModule } from './directory.ts';
import { OperationError, type PageContext } from './shared.ts';

const academyId = 'AC_TEST_A';

function setup(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  directoryModule.setup(db);
  db.prepare('INSERT INTO academies (id, name) VALUES (?, ?)').run(
    academyId,
    '자료 승인 테스트',
  );
  documentsModule.setup(db);
  const admin: PageContext = {
    db,
    actor: {
      id: 'admin',
      academyId,
      username: 'admin',
      name: '관리자',
      role: 'admin',
      studentId: null,
    },
    url: new URL('http://127.0.0.1/documents'),
  };
  return {
    admin,
    visitor: {
      ...admin,
      actor: { ...admin.actor, id: 'visitor', role: 'visitor' as const },
    },
  };
}

function submit(ctx: PageContext, fields: Record<string, string>) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  return documentsModule.submit(ctx, form);
}

function assertStatus(status: number) {
  return (error: unknown) =>
    error instanceof OperationError && error.status === status;
}

test('색인을 검증하는 중 기존 공개 자료를 철회하면 새 개정판을 공개하지 않는다', async (t) => {
  const { admin, visitor } = setup(t);
  const id = await save(
    admin,
    '공개 자료',
    '현재 공개된 수업 운영 규정입니다.',
  );
  await submit(admin, { action: 'approve', documentId: id, revision: '1' });
  await save(admin, '개정 초안', '변경 예정인 수업 운영 규정입니다.', id);
  const approval = Promise.resolve(
    submit(admin, {
      action: 'approve',
      documentId: id,
      revision: '2',
    }),
  );
  const rejected = assert.rejects(approval, assertStatus(409));
  await submit(admin, { action: 'withdraw', documentId: id, revision: '1' });
  await rejected;
  assert.equal(currentDocumentRevisions(visitor).has(id), false);
  assert.equal(
    admin.db
      .prepare(
        'SELECT state FROM op_document_versions WHERE academy_id = ? AND document_id = ? AND revision = 2',
      )
      .get(academyId, id)?.state,
    'draft',
  );
});

async function save(
  ctx: PageContext,
  title: string,
  body: string,
  base?: string,
  fields: Record<string, string> = {},
) {
  await submit(ctx, {
    action: 'save',
    title,
    documentType: 'policy',
    visibility: 'academy_public',
    text: body,
    ...(base ? { documentId: base, baseRevision: '1' } : {}),
    ...fields,
  });
  const row = ctx.db
    .prepare(
      "SELECT document_id FROM op_document_versions WHERE json_extract(input, '$.title') = ?",
    )
    .get(title);
  assert.ok(row && typeof row.document_id === 'string');
  return row.document_id;
}

function access(ctx: PageContext) {
  return {
    actorId: ctx.actor.id,
    academyId: ctx.actor.academyId,
    role: ctx.actor.role,
    allowedStudentIds: [],
    allowedClassIds: [],
    studentRefs: [],
    canViewPublicHistory: false,
  };
}

async function found(
  ctx: PageContext,
  index: Awaited<ReturnType<typeof buildDocumentsIndex>>,
  documentId: string,
  query: string,
) {
  const results = await index.searchApprovedChunks({
    access: access(ctx),
    studentIds: [],
    asOf: Date.now(),
    query,
    limit: 10,
  });
  return results.some(({ chunk }) => chunk.documentId === documentId);
}

test('검증에 실패한 개정판을 승인하지 않고 기존 공개 자료를 유지한다', async (t) => {
  const { admin, visitor } = setup(t);
  const id = await save(
    admin,
    '자습실 운영 규정',
    '보라별 예약 규정에 따라 자습실을 이용합니다.',
  );
  await submit(admin, { action: 'approve', documentId: id, revision: '1' });
  const previous = documentsIndexVersion(admin.db, academyId, [], []);
  await save(admin, '자습실 개정 초안', '# 제목만 있는 자료', id);
  await assert.rejects(
    async () =>
      submit(admin, { action: 'approve', documentId: id, revision: '2' }),
    assertStatus(422),
  );
  assert.equal(documentsIndexVersion(admin.db, academyId, [], []), previous);
  assert.deepEqual(currentDocumentRevisions(visitor).get(id), new Set([1]));
  assert.equal(
    admin.db
      .prepare(
        'SELECT state FROM op_document_versions WHERE document_id = ? AND revision = 2',
      )
      .get(id)?.state,
    'draft',
  );
  assert.equal(
    await found(
      visitor,
      await buildDocumentsIndex(admin.db, academyId, [], []),
      id,
      '보라별 예약 규정',
    ),
    true,
  );
});

test('이전 코드가 승인한 불량 자료는 같은 학원의 다른 자료를 중단시키지 않는다', async (t) => {
  const { admin, visitor } = setup(t);
  const id = await save(
    admin,
    '상담 접수 규정',
    '라임별 상담 신청은 수요일에 받습니다.',
  );
  await submit(admin, { action: 'approve', documentId: id, revision: '1' });
  const broken: SourceDocumentInput = {
    academyId,
    documentId: 'legacy-broken',
    revision: 1,
    documentType: 'policy',
    title: '이전 코드에서 승인한 자료',
    text: '# 본문 없음',
    validFrom: '2020-01-01T00:00:00Z',
    approvedAt: '2020-01-01T00:00:00Z',
    visibility: 'academy_public',
  };
  admin.db
    .prepare(
      "INSERT INTO op_document_versions (academy_id, document_id, revision, input, state) VALUES (?, ?, ?, ?, 'published')",
    )
    .run(academyId, broken.documentId, broken.revision, JSON.stringify(broken));
  const index = await buildDocumentsIndex(admin.db, academyId, [], []);
  assert.equal(await found(visitor, index, id, '라임별 상담 신청'), true);
  assert.equal(
    await found(visitor, index, broken.documentId, '본문 없음'),
    false,
  );
});

test('개정판 승인과 철회가 상담 색인과 이력 출처를 즉시 갱신한다', async (t) => {
  const { admin, visitor } = setup(t);
  const id = await save(
    admin,
    '예약 절차',
    '금색별 수업 상담은 화요일에 신청합니다.',
  );
  await submit(admin, { action: 'approve', documentId: id, revision: '1' });
  const [first, duplicate] = await Promise.all([
    buildDocumentsIndex(admin.db, academyId, [], []),
    buildDocumentsIndex(admin.db, academyId, [], []),
  ]);
  assert.equal(first, duplicate);
  await save(
    admin,
    '예약 절차 개정',
    '금색별 수업 상담은 월요일에 신청합니다.',
    id,
  );
  assert.equal(await buildDocumentsIndex(admin.db, academyId, [], []), first);
  await submit(admin, { action: 'approve', documentId: id, revision: '2' });
  assert.deepEqual(currentDocumentRevisions(visitor).get(id), new Set([2]));
  const second = await buildDocumentsIndex(admin.db, academyId, [], []);
  assert.notEqual(second, first);
  await assert.rejects(
    async () =>
      submit(admin, { action: 'withdraw', documentId: id, revision: '1' }),
    assertStatus(409),
  );
  await assert.rejects(
    async () =>
      submit(visitor, { action: 'withdraw', documentId: id, revision: '2' }),
    assertStatus(403),
  );
  const outdated = assert.rejects(
    buildDocumentsIndex(admin.db, academyId, [], []),
    assertStatus(409),
  );
  await submit(admin, { action: 'withdraw', documentId: id, revision: '2' });
  await outdated;
  const third = await buildDocumentsIndex(admin.db, academyId, [], []);
  assert.notEqual(third, second);
  assert.equal(await found(visitor, third, id, '금색별 수업 상담'), false);
  assert.equal(currentDocumentRevisions(visitor).has(id), false);
  assert.equal(currentDocumentRevisions(admin).has(id), false);
});

test('색인 검증 중 권한이 바뀐 관리자 요청은 공개 상태를 변경하지 못한다', async (t) => {
  const { admin } = setup(t);
  const id = await save(admin, '자습 규정', '중등 자습은 목요일에 진행합니다.');
  let active = true;
  const pending = assert.rejects(
    async () =>
      submit(
        {
          ...admin,
          assertCurrentAccess() {
            if (!active)
              throw new OperationError('로그인이 만료되었습니다.', 401);
          },
        },
        { action: 'approve', documentId: id, revision: '1' },
      ),
    assertStatus(401),
  );
  active = false;
  await pending;
  assert.equal(
    admin.db
      .prepare('SELECT state FROM op_document_versions WHERE document_id = ?')
      .get(id)?.state,
    'draft',
  );
});

test('승인된 미래 개정판은 인용할 수 있고 비공개 범위 변경은 즉시 적용한다', async (t) => {
  const { admin, visitor } = setup(t);
  const id = await save(
    admin,
    '금요일 운영 규정',
    '푸른별 자습실을 금요일에 운영합니다.',
  );
  await submit(admin, { action: 'approve', documentId: id, revision: '1' });
  const futureAt = Date.now() + 2 * 24 * 60 * 60 * 1000;
  const futureLocal = (at: number) =>
    new Date(at + 9 * 60 * 60 * 1000).toISOString().slice(0, 16);
  await save(
    admin,
    '토요일 운영 규정',
    '푸른별 자습실을 토요일에 운영합니다.',
    id,
    {
      validFrom: futureLocal(futureAt),
    },
  );
  await submit(admin, { action: 'approve', documentId: id, revision: '2' });

  const download = (revision: number) =>
    documentDownload({
      ...visitor,
      url: new URL(
        `http://127.0.0.1/documents/download?id=${id}&revision=${revision}`,
      ),
    });
  assert.deepEqual(currentDocumentRevisions(visitor).get(id), new Set([1, 2]));
  assert.match(download(2).content.toString(), /토요일/);
  const citable = {
    access: access(visitor),
    studentIds: [],
    asOf: Date.now(),
    effectiveAt: futureAt,
    sourceId: id + ':r2:body',
  };
  const first = await buildDocumentsIndex(admin.db, academyId, [], []);
  assert.equal((await first.getCitableSource(citable))?.revision, 2);

  await save(
    admin,
    '교직원 열람용 운영 규정',
    '푸른별 자습실을 일요일에 운영합니다.',
    id,
    {
      baseRevision: '2',
      validFrom: futureLocal(futureAt + 24 * 60 * 60 * 1000),
      visibility: 'staff_only',
    },
  );
  await submit(admin, { action: 'approve', documentId: id, revision: '3' });
  const restricted = await buildDocumentsIndex(admin.db, academyId, [], []);
  assert.equal(currentDocumentRevisions(visitor).has(id), false);
  assert.deepEqual(currentDocumentRevisions(admin).get(id), new Set([1, 2, 3]));
  assert.throws(() => download(1), assertStatus(404));
  assert.throws(() => download(2), assertStatus(404));
  assert.equal(
    await restricted.getCitableSource({ ...citable, asOf: Date.now() }),
    null,
  );
  assert.equal(await found(visitor, restricted, id, '푸른별 자습실'), false);

  await save(
    admin,
    '다음 공개 운영 규정',
    '푸른별 자습실을 월요일에 운영합니다.',
    id,
    {
      baseRevision: '3',
      validFrom: futureLocal(futureAt + 2 * 24 * 60 * 60 * 1000),
    },
  );
  await submit(admin, { action: 'approve', documentId: id, revision: '4' });
  assert.deepEqual(currentDocumentRevisions(visitor).get(id), new Set([4]));
  assert.throws(() => download(1), assertStatus(404));
});

test('자료 검색과 선택 자료 답변 미리보기는 승인된 해당 문서만 사용한다', async (t) => {
  const { admin, visitor } = setup(t);
  const one = await save(
    admin,
    '봄학기 운영규정',
    '수업 시작 전에 교재를 준비해 주세요.',
  );
  const two = await save(
    admin,
    '여름학기 수강료',
    '여름 특강 수강료는 777000원입니다.',
  );
  await submit(admin, { action: 'approve', documentId: one, revision: '1' });
  await submit(admin, { action: 'approve', documentId: two, revision: '1' });
  const search = {
    ...admin,
    url: new URL('http://localhost/documents?q=봄학기'),
  };
  const list = await documentsModule.render(search);
  assert.match(list, /봄학기 운영규정/);
  assert.doesNotMatch(list, /여름학기 수강료/);
  const ctx = {
    ...admin,
    url: new URL(
      'http://localhost/documents?id=' +
        one +
        '&revision=1&previewQuestion=' +
        encodeURIComponent('여름 특강 수강료 얼마예요?'),
    ),
  };
  const preview = await documentsModule.render(ctx);
  assert.match(preview, /선택한 자료 한 개만 사용/);
  assert.doesNotMatch(preview, /777000/);
  const draft = await save(admin, '미승인 안내', '미승인입니다.');
  const hidden = await documentsModule.render({
    ...admin,
    url: new URL(
      'http://localhost/documents?id=' +
        draft +
        '&revision=1&previewQuestion=안내',
    ),
  });
  assert.doesNotMatch(hidden, /answer-preview/);
  const publicView = await documentsModule.render({ ...visitor, url: ctx.url });
  assert.doesNotMatch(publicView, /answer-preview/);
});
