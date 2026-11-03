import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { FixedClock } from '../adapters/memory/index.ts';
import type { AnswerContext } from '../answer/context.ts';
import {
  classSimilarity,
  classTableRows,
  renderTableRows,
} from '../answer/info.ts';
import { DEFAULT_RAG_CONFIG } from '../config.ts';
import { DisabledGenerationProvider } from '../generation/providers.ts';
import {
  prepareFileDocument,
  type FileDocumentMeta,
} from '../ingest/ingest-file.ts';
import { splitIntoBlocks } from '../ingest/chunking.ts';
import { parseQuery } from '../query/parse-query.ts';
import { InMemoryRagStore } from '../store/in-memory-store.ts';
import { parseInstant } from '../text/time.ts';
import type { AcademyCatalog, RagAccessScope, RagChunk } from '../types.ts';
import { runQuery } from './helpers.ts';

const at = parseInstant('2026-11-03T12:00:00+09:00');
const access: RagAccessScope = {
  actorId: 'table-visitor',
  academyId: 'AC_TABLE',
  role: 'visitor',
  allowedStudentIds: [],
  allowedClassIds: [],
  studentRefs: [],
  canViewPublicHistory: true,
};
const catalog: AcademyCatalog = {
  academyId: access.academyId,
  displayName: '표검증학원',
  aliases: [],
  classes: [{ classId: 'C_ADV', name: '중2 심화반', aliases: [] }],
  units: [],
};

function rows(markdown: string): RagChunk[] {
  return splitIntoBlocks(markdown).map((block, index) => ({
    ...block,
    chunkId: `TABLE:r1:body#${index}`,
    sourceId: 'TABLE:r1:body',
    documentId: 'TABLE',
    revision: 1,
    academyId: access.academyId,
    studentId: null,
    classId: null,
    documentType: 'schedule',
    visibility: 'academy_public',
    validFrom: at,
    validTo: null,
    title: '반별 안내',
    contextualText: block.text,
    tokens: [],
    suspicious: false,
  }));
}

async function context(
  markdown: string,
  question: string,
  pdf?: Uint8Array,
  testCatalog = catalog,
): Promise<AnswerContext & { documents: InMemoryRagStore }> {
  const store = new InMemoryRagStore();
  const metadata: FileDocumentMeta = {
    academyId: access.academyId,
    documentId: 'TABLE',
    revision: 1,
    documentType: 'schedule',
    visibility: 'academy_public',
    title: '반별 시간표',
    validFrom: '2026-11-01T00:00:00+09:00',
    validTo: null,
    approvedAt: '2026-11-01T00:00:00+09:00',
  };
  const document = pdf
    ? (
        await prepareFileDocument(
          metadata,
          { bytes: pdf, fileName: 'schedule.pdf' },
          { ocr: null },
        )
      ).document
    : { ...metadata, text: markdown };
  assert.ok(document);
  const result = await store.upsertIndexedRevision({ approve: true, document });
  assert.equal(result.status, 'activated');
  return {
    access,
    catalog: testCatalog,
    frame: parseQuery(question, {
      access,
      catalog: testCatalog,
      config: DEFAULT_RAG_CONFIG,
    }),
    question,
    asOf: at,
    state: null,
    config: DEFAULT_RAG_CONFIG,
    facts: store,
    documents: store,
    generation: new DisabledGenerationProvider(),
    clock: new FixedClock(at),
    studentClassIds: [],
    trace: {
      requestId: 'table-test',
      domain: 'info',
      intent: 'schedule',
      retrievedChunkIds: [],
      retrievedFactIds: [],
      usedFactIds: [],
      generationCalls: 0,
      generationInputFactIds: [],
      generationInputSourceIds: [],
      internalErrors: [],
      targetStudentIds: [],
    },
  };
}

describe('표의 반·열 귀속', () => {
  test('정확한 대상 행이 있으면 함께 검색된 다른 반 행은 출력하지 않는다', () => {
    const chunks = rows(
      '| 반 | 교실 |\n|---|---|\n| 중2 심화반 | 301호 |\n| 중1 심화반 | 201호 |',
    );
    assert.deepEqual(
      renderTableRows(chunks, ['교실'], [], () => true, ['중2 심화반']),
      ['반: 중2 심화반 / 교실: 301호'],
    );
  });

  test('같은 이름이어도 다른 학년·학교급이면 유사 행으로 결합하지 않는다', () => {
    assert.equal(classSimilarity('중2 심화반', '중3 심화'), 0);
    assert.equal(classSimilarity('중2 심화반', '고2 심화'), 0);
    assert.ok(classSimilarity('중2 심화반', '중등 2학년 심화') >= 1.3);
  });

  test('대상 행이 없을 때 다른 학년 행으로 대신 답하지 않는다', () => {
    const chunks = rows('| 반 | 교실 |\n|---|---|\n| 중3 심화 | 401호 |');
    assert.deepEqual(
      renderTableRows(chunks, ['교실'], [], () => true, ['중2 심화반']),
      [],
    );
  });

  test('두 반 비교에서는 각 반의 가장 가까운 행을 모두 유지한다', () => {
    const chunks = rows(
      '| 반 | 교실 |\n|---|---|\n| 중2 심화 | 301호 |\n| 중3 기본 | 401호 |\n| 중1 기본 | 201호 |',
    );
    assert.deepEqual(
      renderTableRows(chunks, ['교실'], [], () => true, [
        '중2 심화반',
        '중3 기본반',
      ]),
      ['반: 중2 심화 / 교실: 301호', '반: 중3 기본 / 교실: 401호'],
    );
  });

  test('열 순서가 다른 표들은 각자의 머리글로 열을 선택한다', () => {
    const chunks = rows(
      '| 구분 | 교실 | 정원 |\n|---|---|---|\n| 오전 | 301호 | 8명 |\n\n| 구분 | 정원 | 교실 |\n|---|---|---|\n| 오후 | 12명 | 401호 |',
    );
    assert.deepEqual(
      renderTableRows(chunks, ['교실'], [], () => true),
      ['구분: 오전 / 교실: 301호', '구분: 오후 / 교실: 401호'],
    );
  });

  test('격자에서는 대상 반과 질문한 요일을 동시에 만족하는 칸만 선택한다', () => {
    const chunks = rows(
      '| 시간 | 월요일 | 화요일 |\n|---|---|---|\n| 16:00 | 중1 기본반 | 중2 심화반 |',
    );
    assert.deepEqual(
      renderTableRows(chunks, ['월요일'], [], () => true, ['중2 심화반']),
      [],
    );
  });

  test('격자의 요일 머리글은 요일 값 열로 오인하지 않고 일치하는 칸을 안내한다', async () => {
    const markdown =
      '| 시간 | 월요일 | 화요일 |\n|---|---|---|\n| 16:00 | 중2 심화반 | 중1 기본반 |';
    const ctx = await context(markdown, '중2 심화반 월요일 시간표');
    assert.deepEqual(
      renderTableRows(
        rows(markdown),
        ['월요일'],
        [],
        () => true,
        ['중2 심화반'],
        ctx,
      ),
      ['시간: 16:00 / 월요일: 중2 심화반'],
    );
  });

  test('특정 반 질문에서도 모든 반에 공통인 반환 기준 표는 유지한다', () => {
    const chunks = rows(
      '| 반환 사유 | 반환 금액 |\n|---|---|\n| 시작 전 | 전액 |',
    );
    assert.deepEqual(
      renderTableRows(chunks, [], [], () => true, ['중2 심화반']),
      ['반환 사유: 시작 전 / 반환 금액: 전액'],
    );
  });
});

describe('행 형태 시간표의 요일·기간 귀속', () => {
  const table =
    '| 반 | 요일 | 시간 |\n|---|---|---|\n| 중2 심화반 | 월·수 | 16:00~17:00 |\n| 중2 심화반 | 화·목 | 18:00~19:00 |';
  const periodTable =
    '| 반 | 요일 | 시간 | 적용 기간 |\n|---|---|---|---|\n| 중2 심화반 | 월·수 | 16:00~17:00 | 11월 1일~11월 15일 |\n| 중2 심화반 | 화·목 | 18:00~19:00 | 11월 16일~11월 30일 |';

  test('행의 요일이 질문한 요일과 다르면 제외한다', async () => {
    const ctx = await context(table, '중2 심화반 화요일 시간표');
    const result = await classTableRows(ctx, 'C_ADV', ['schedule']);
    assert.equal(result.length, 1);
    assert.match(result[0].line, /18:00/);
    assert.doesNotMatch(result[0].line, /16:00/);
  });

  test('적용 기간을 지정한 질문은 그 기간의 행만 남긴다', async () => {
    const ctx = await context(periodTable, '중2 심화반 11월 18일 시간표');
    const day = parseInstant('2026-11-18T00:00:00+09:00');
    assert.deepEqual(
      await classTableRows(ctx, 'C_ADV', ['schedule'], {
        at: day,
        explicitDay: day,
      }),
      [],
    );
  });

  test('같은 반이라도 질문한 요일에 수업이 없으면 다른 요일을 안내하지 않는다', async () => {
    const ctx = await context(table, '중2 심화반 토요일 시간표');
    const seen = { offDay: false };
    assert.deepEqual(
      await classTableRows(ctx, 'C_ADV', ['schedule'], undefined, seen),
      [],
    );
    assert.equal(seen.offDay, true);
  });

  test('요일과 적용 기간이 모두 맞으면 해당 행을 안내한다', async () => {
    const ctx = await context(periodTable, '중2 심화반 11월 19일 시간표');
    const day = parseInstant('2026-11-19T00:00:00+09:00');
    const result = await classTableRows(ctx, 'C_ADV', ['schedule'], {
      at: day,
      explicitDay: day,
    });
    assert.equal(result.length, 1);
    assert.match(result[0].line, /18:00/);
  });

  test('요일 범위와 붙여 쓴 요일도 행의 요일로 판별한다', async () => {
    for (const days of ['월~금', '월수금', '평일']) {
      const ctx = await context(
        `| 반 | 요일 | 시간 |\n|---|---|---|\n| 중2 심화반 | ${days} | 16:00~17:00 |`,
        '중2 심화반 수요일 시간표',
      );
      assert.equal(
        (await classTableRows(ctx, 'C_ADV', ['schedule'])).length,
        1,
        days,
      );
    }
  });

  test('평일이라는 말의 마지막 글자를 일요일 수업으로 읽지 않는다', async () => {
    const ctx = await context(
      '| 반 | 요일 | 시간 |\n|---|---|---|\n| 중2 심화반 | 평일 | 16:00~17:00 |',
      '중2 심화반 일요일 시간표',
    );
    assert.deepEqual(await classTableRows(ctx, 'C_ADV', ['schedule']), []);
  });

  test('날짜를 말하지 않아도 미래 적용 행은 현재 시간표에 섞지 않는다', async () => {
    const ctx = await context(periodTable, '중2 심화반 시간표');
    const result = await classTableRows(ctx, 'C_ADV', ['schedule']);
    assert.equal(result.length, 1);
    assert.match(result[0].line, /16:00/);
  });

  test('상담 서비스의 문서 재검색에서도 수업이 없는 요일의 다른 행을 답하지 않는다', async () => {
    const question = '중2 심화반 토요일 시간표';
    const ctx = await context(table, question);
    const result = await runQuery(
      {
        store: ctx.documents,
        catalog: {
          async getAcademyCatalog() {
            return catalog;
          },
        },
        resolveScope: () => access,
      },
      { userId: access.actorId, question, asOf: '2026-11-03T12:00:00+09:00' },
    );
    assert.equal(result.answer.status, 'abstained');
    assert.doesNotMatch(result.answer.answer, /16:00|18:00/);
  });

  test('상담 서비스에서 요일과 기간이 맞는 행의 시간은 정상적으로 답한다', async () => {
    const question = '중2 심화반 11월 19일 시간표';
    const ctx = await context(periodTable, question);
    const result = await runQuery(
      {
        store: ctx.documents,
        catalog: {
          async getAcademyCatalog() {
            return catalog;
          },
        },
        resolveScope: () => access,
      },
      { userId: access.actorId, question, asOf: '2026-11-03T12:00:00+09:00' },
    );
    assert.equal(result.answer.status, 'answered');
    assert.match(result.answer.answer, /18:00/);
    assert.doesNotMatch(result.answer.answer, /16:00/);
    assert.equal(result.answer.citations[0]?.documentId, 'TABLE');
  });
});

async function askTable(ctx: Awaited<ReturnType<typeof context>>) {
  return (
    await runQuery(
      {
        store: ctx.documents,
        catalog: {
          async getAcademyCatalog() {
            return ctx.catalog;
          },
        },
        resolveScope: () => access,
      },
      {
        userId: access.actorId,
        question: ctx.question,
        asOf: '2026-11-03T12:00:00+09:00',
      },
    )
  ).answer;
}

test('요일 열의 독립 표현, 휴강 및 예외를 상담에서 검증한다', async () => {
  const cases = [
    ['월·수 (공휴일 제외)', '일요일', false],
    ['평일 (공휴일 제외)', '일요일', false],
    ['일반 일정', '일요일', false],
    ['월~금', '수요일', true],
    ['월수금', '금요일', true],
    ['월요일·수요일', '수요일', true],
    ['주말', '일요일', true],
    ['매일', '월요일', true],
    ['토요일 수업 없음', '토요일', false],
    ['매일 (토요일 휴강)', '토요일', false],
    ['매일 (토요일 휴강)', '금요일', true],
    ['평일 (공휴일 제외)', '공휴일인 월요일', false],
    ['월·수 (11월 4일 휴강)', '11월 4일 수요일', false],
    ['월·수 (11월 4일 휴강)', '11월 11일 수요일', true],
    ['월·수', '11월 4일 월요일', false],
  ] as const;
  for (const [days, date, expected] of cases) {
    const ctx = await context(
      '| 반 | 요일 | 시간 |\n|---|---|---|\n| 중2 심화반 | ' +
        days +
        ' | 16:00~17:00 |',
      '중2 심화반 ' + date + ' 시간표',
    );
    assert.equal(
      (await askTable(ctx)).status,
      expected ? 'answered' : 'abstained',
      days + ' / ' + date,
    );
  }
});

test('교시 격자에서 여러 행의 대상 칸만 답하고 해당 열만 인용한다', async () => {
  const ctx = await context(
    '| 시간 | 1교시 | 2교시 |\n|---|---|---|\n| 16:00 | 중2 심화반 | 중1 기본반 |\n| 17:00 | 고2 심화반 | 중2 심화반 |\n| 18:00 | 중1 기본반 | 고2 심화반 |',
    '중2 심화반 시간표',
  );
  const answer = await askTable(ctx);
  assert.equal(answer.status, 'answered');
  assert.match(answer.answer, /16:00 \/ 1교시: 중2 심화반/);
  assert.match(answer.answer, /17:00 \/ 2교시: 중2 심화반/);
  assert.doesNotMatch(answer.answer, /중1 기본반|고2 심화반|18:00/);
  const location = answer.citations[0]?.location ?? '';
  assert.match(location, /1행 · 열 1교시/);
  assert.match(location, /2행 · 열 2교시/);
  assert.doesNotMatch(location, /3행|1행 · 열 2교시|2행 · 열 1교시/);
});

test('교실·강사 격자는 열 순서와 상관없이 복수 대상 반만 선택한다', () => {
  const tables = rows(
    '| 시간 | 301호 | 302호 | 303호 |\n|---|---|---|---|\n| 16:00 | 중1 기본반 | 중2 심화반 | 고2 심화반 |\n\n| 시간 | 이 강사 | 김 강사 | 박 강사 |\n|---|---|---|---|\n| 16:00 | 고2 심화반 | 중1 기본반 | 중2 심화반 |',
  );
  assert.deepEqual(
    renderTableRows(tables, [], [], () => true, ['중2 심화반', '고2 심화반']),
    [
      '시간: 16:00 / 302호: 중2 심화반 / 303호: 고2 심화반',
      '시간: 16:00 / 이 강사: 고2 심화반 / 박 강사: 중2 심화반',
    ],
  );
});

test('반 열이 중간에 있는 행 기반 표는 같은 행의 배치 정보를 선택한다', () => {
  const table = rows(
    '| 강사 | 반 | 교실 |\n|---|---|---|\n| 김 강사 | 중1 기본반 | 301호 |\n| 박 강사 | 중2 심화반 | 302호 |',
  );
  assert.deepEqual(
    renderTableRows(table, [], [], () => true, ['중2 심화반']),
    ['강사: 박 강사 / 반: 중2 심화반 / 교실: 302호'],
  );
});

test('대상 칸이 없거나 대상 요일의 칸이 휴강이면 보류한다', async () => {
  for (const [markdown, question] of [
    [
      '| 시간 | 1교시 | 2교시 |\n|---|---|---|\n| 16:00 | 고2 심화반 | 중1 기본반 |',
      '중2 심화반 시간표',
    ],
    [
      '| 시간 | 월요일 | 토요일 |\n|---|---|---|\n| 16:00 | 중2 심화반 | 중2 심화반 (휴강) |',
      '중2 심화반 토요일 시간표',
    ],
  ]) {
    const answer = await askTable(await context(markdown, question));
    assert.equal(answer.status, 'abstained');
    assert.deepEqual(answer.citations, []);
  }
});

test('PDF에서 추출한 요일 격자를 등록하고 선택한 쪽·행·열을 인용한다', async () => {
  const path = new URL(
    '../__fixtures__/academies-v2/AC_HANGYEOL/documents/HK_TIMETABLE_2026_2__r1.pdf',
    import.meta.url,
  );
  const question = '중2 내신A반 월요일 시간표';
  const ctx = await context('', question, readFileSync(path), {
    ...catalog,
    classes: [{ classId: 'C_ADV', name: '중2 내신A반', aliases: [] }],
  });
  const answer = await askTable(ctx);
  assert.equal(answer.status, 'answered');
  assert.match(answer.answer, /18:20~19:50/);
  assert.doesNotMatch(answer.answer, /중2 내신B반|14:40~16:10/);
  assert.match(answer.citations[0]?.location ?? '', /1쪽.*행 · 열 월(?:$| ·)/);
});

test('같은 절의 반별 표와 공통 규정 표를 각각 유지한다', () => {
  const tables = rows(
    '| 반 | 교실 |\n|---|---|\n| 중2 심화반 | 301호 |\n| 중1 기본반 | 201호 |\n\n| 반환 사유 | 반환 금액 |\n|---|---|\n| 시작 전 | 전액 |',
  );
  assert.deepEqual(
    renderTableRows(tables, [], [], () => true, ['중2 심화반']),
    ['반: 중2 심화반 / 교실: 301호', '반환 사유: 시작 전 / 반환 금액: 전액'],
  );
});

test('요일에 붙은 조사와 휴강 범위를 각각 해석한다', async () => {
  for (const [schedule, asked, expected] of [
    ['매일 (토요일은 휴강)', '금요일에', 'answered'],
    ['매일 (토요일은 휴강)', '토요일에는', 'abstained'],
    ['주말과 평일', '토요일', 'answered'],
    ['월요일은 수업 없음', '월요일', 'abstained'],
    ['월요일은 수업 없음', '화요일', 'abstained'],
    ['평일 (공휴일 제외)', '일요일', 'abstained'],
    ['월·수', '금요일', 'abstained'],
  ]) {
    const ctx = await context(
      '| 반 | 요일 | 시간 |\n|---|---|---|\n| 중2 심화반 | ' +
        schedule +
        ' | 16:00~17:00 |',
      '중2 심화반 ' + asked + ' 시간표',
    );
    const answer = await askTable(ctx);
    assert.equal(answer.status, expected, schedule + ' / ' + asked);
    if (expected === 'abstained')
      assert.doesNotMatch(answer.answer, /화요일.*휴강/);
  }
});

test('복합 질문은 반을 이어받되 시간표의 요일을 유지하고 없는 수강료를 부분 보류한다', async () => {
  const ctx = await context(
    '| 시간 | 월요일 | 화요일 |\n|---|---|---|\n| 16:00 | 중2 심화반 | |\n| 17:30 | | 중2 심화반 |',
    '중2 심화반 수강료랑 화요일 시간표 알려줘',
  );
  const answer = await askTable(ctx);
  assert.equal(answer.status, 'partial', answer.answer);
  assert.match(answer.answer, /17:30/);
  assert.doesNotMatch(answer.answer, /16:00/);
});

test('관련 납부 안내는 발급 근거가 아니고, 발급 조건이 확인되는 문장만 답한다', async () => {
  const question = '계좌이체하면 현금 영수증을 발급받을 수 있나요?';
  const noEvidence = await context(
    '수강료는 계좌이체로 납부할 수 있습니다.',
    question,
  );
  assert.equal((await askTable(noEvidence)).status, 'abstained');
  const otherMethod = await context(
    '카드 결제 시 현금 영수증 발급이 가능합니다.',
    question,
  );
  assert.equal((await askTable(otherMethod)).status, 'abstained');
  const supported = await context(
    '계좌이체 시 현금 영수증을 발급해 드립니다.',
    question,
  );
  const answer = await askTable(supported);
  assert.equal(answer.status, 'answered');
  assert.match(answer.answer, /현금 영수증을 발급/);
});

test('반 전용 문서의 메타데이터가 질문 대상과 다르면 표 이름이 같아도 제외한다', async () => {
  const ctx = await context(
    '| 반 | 요일 | 시간 |\n|---|---|---|\n| 중2 심화반 | 화요일 | 16:00 |',
    '중2 심화반 화요일 시간표',
  );
  await ctx.documents.revokeRevision({
    documentId: 'TABLE',
    reason: 'revoked',
  });
  const result = await ctx.documents.upsertIndexedRevision({
    approve: true,
    document: {
      academyId: access.academyId,
      documentId: 'WRONG_SCOPE',
      revision: 1,
      classId: 'OTHER_CLASS',
      documentType: 'schedule',
      title: '반별 시간표',
      visibility: 'academy_public',
      validFrom: '2026-11-01T00:00:00+09:00',
      validTo: null,
      approvedAt: '2026-11-01T00:00:00+09:00',
      text: '| 반 | 요일 | 시간 |\n|---|---|---|\n| 중2 심화반 | 화요일 | 19:25 |',
    },
  });
  assert.equal(result.status, 'activated');
  const answer = await askTable(ctx);
  assert.equal(answer.status, 'abstained');
  assert.deepEqual(answer.citations, []);
});

test('쪽마다 열 순서가 달라도 선택한 셀만 인용하고 개정·철회 후 이전 근거를 쓰지 않는다', async () => {
  const first =
    '<!-- page 1 -->\n| 시간 | A실 | B실 |\n|---|---|---|\n| 16:10 | 중2 심화반 | 중1 기본반 |\n\n<!-- page 2 -->\n| 시간 | B실 | A실 |\n|---|---|---|\n| 18:20 | 중2 심화반 | 중1 기본반 |';
  const ctx = await context(first, '중2 심화반 시간표');
  const before = await askTable(ctx);
  assert.equal(before.status, 'answered');
  assert.match(before.citations[0]?.location ?? '', /1쪽[^;]*열 A실/);
  assert.match(before.citations[0]?.location ?? '', /2쪽[^;]*열 B실/);
  assert.doesNotMatch(before.answer, /중1 기본반/);
  const result = await ctx.documents.upsertIndexedRevision({
    approve: true,
    document: {
      academyId: access.academyId,
      documentId: 'TABLE',
      revision: 2,
      documentType: 'schedule',
      title: '반별 시간표',
      visibility: 'academy_public',
      validFrom: '2026-11-01T00:00:00+09:00',
      validTo: null,
      approvedAt: '2026-11-02T00:00:00+09:00',
      text: '<!-- page 3 -->\n| 시간 | A실 | B실 |\n|---|---|---|\n| 19:35 | 중1 기본반 | 중2 심화반 |',
    },
  });
  assert.equal(result.status, 'activated');
  const after = await askTable(ctx);
  assert.match(after.answer, /19:35/);
  assert.doesNotMatch(after.answer, /16:10|18:20|중1 기본반/);
  assert.equal(after.citations[0]?.revision, 2);
  assert.match(after.citations[0]?.location ?? '', /3쪽.*열 B실/);
  await ctx.documents.revokeRevision({
    documentId: 'TABLE',
    reason: 'revoked',
  });
  const revoked = await askTable(ctx);
  assert.equal(revoked.status, 'abstained');
  assert.deepEqual(revoked.citations, []);
});
