/**
 * 합성 평가자료(AXR_RAG_Synthetic_Preimplementation_v1) → 저장소·카탈로그·모의 세션 어댑터.
 *
 * ⚠️ 테스트·로컬 개발 전용. users.json 의 계정을 "모의 서버 세션"으로 바꾸는 것은
 *    테스트 러너에서만 허용되며, 운영에서 임의 사용자 ID 요청을 받아들이면 안 된다.
 *
 * 합성 자료에 없는 정보를 채우기 위한 가정(문서화된 어댑터 규칙):
 * - 학원 표시 이름: 문서 제목 앞의 "X학원"
 * - 반 이름: 반 문서 본문의 "중N…반" 표기
 * - 형제 순서(첫째/둘째): users.json 의 allowed_student_ids 순서
 * - 공개 수강료·시간표의 과거 이력 열람: 허용(합성 학원의 정책 가정)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { InMemoryRagStore } from '../../store/in-memory-store.ts';
import type { AccessScopePort, CatalogPort } from '../../ports.ts';
import type {
  AcademyCatalog,
  ApprovedFactInput,
  ConversationState,
  DocumentType,
  FactType,
  FactValue,
  RagAccessScope,
  RagRole,
  SourceDocumentInput,
} from '../../types.ts';

export interface FixtureUser {
  user_id: string;
  role: RagRole;
  academy_id: string;
  allowed_student_ids: string[];
  allowed_class_ids: string[];
}

export interface FixtureDocument {
  academy_id: string;
  class_id: string | null;
  document_id: string;
  document_type: string;
  fact_ids: string[];
  revision: number;
  source_id: string;
  status: string;
  student_id: string | null;
  text: string;
  title: string;
  valid_from: string;
  valid_to: string | null;
}

export interface FixtureFact {
  academy_id: string;
  document_id: string;
  fact_id: string;
  fact_type: string;
  period: string | null;
  revision: number;
  source_id: string;
  subject_id: string;
  subject_type: 'student' | 'class' | 'academy';
  unit: string | null;
  valid_from: string;
  valid_to: string | null;
  value: unknown;
}

export interface FixtureCase {
  case_id: string;
  split: 'dev' | 'holdout';
  category: string;
  scenario_group: string;
  tags: string[];
  input: {
    user_id: string;
    query: string;
    as_of: string;
    session: Record<string, unknown>;
    api_state: 'ok' | '429' | '5xx' | 'timeout' | 'quota_exhausted';
  };
  expected: {
    status: string;
    fact_ids: string[];
    source_ids: string[];
    generation_budget_max: number;
    notes?: string;
  };
}

export interface FixtureData {
  users: FixtureUser[];
  documents: FixtureDocument[];
  facts: FixtureFact[];
  cases: FixtureCase[];
}

export const FIXTURE_DIR = join(
  import.meta.dirname,
  '..',
  '..',
  '__fixtures__',
  'axr-synthetic-v1',
);

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
}

export function readFixtureData(dir: string = FIXTURE_DIR): FixtureData {
  return {
    users: JSON.parse(
      readFileSync(join(dir, 'users.json'), 'utf-8'),
    ) as FixtureUser[],
    documents: readJsonl<FixtureDocument>(join(dir, 'corpus.jsonl')),
    facts: readJsonl<FixtureFact>(join(dir, 'facts.jsonl')),
    cases: readJsonl<FixtureCase>(join(dir, 'cases.jsonl')),
  };
}

function toFactValue(fact: FixtureFact): FactValue {
  const raw = fact.value;
  if (fact.fact_type === 'monthly_fee' && typeof raw === 'number') {
    return { kind: 'money', amount: raw, currency: 'KRW' };
  }
  if (fact.fact_type === 'accuracy' && raw && typeof raw === 'object') {
    const value = raw as { correct: number; total: number; unit: string };
    return {
      kind: 'accuracy',
      correct: value.correct,
      total: value.total,
      unit: value.unit,
    };
  }
  if (fact.fact_type === 'schedule' && typeof raw === 'string')
    return { kind: 'schedule', text: raw };
  if (fact.fact_type === 'holiday' && typeof raw === 'string') {
    // v1 합성 자료의 휴강 사실 → 휴보강(schedule_change) 형식
    const date = raw.match(/\d{4}-\d{2}-\d{2}/)?.[0];
    if (date) {
      return {
        kind: 'schedule_change',
        changeType: 'cancel',
        date,
        time: null,
        text: raw.replace(date, '').trim() || '휴강',
      };
    }
  }
  return { kind: 'text', text: String(raw) };
}

export function toFactInput(fact: FixtureFact): ApprovedFactInput {
  return {
    factId: fact.fact_id,
    sourceId: fact.source_id,
    documentId: fact.document_id,
    revision: fact.revision,
    academyId: fact.academy_id,
    subjectType: fact.subject_type,
    subjectId: fact.subject_id,
    factType: (fact.fact_type === 'holiday'
      ? 'schedule_change'
      : fact.fact_type) as FactType,
    value: toFactValue(fact),
    period: fact.period,
    validFrom: fact.valid_from,
    validTo: fact.valid_to,
    approvalStatus: 'approved',
  };
}

export function toDocumentInput(
  document: FixtureDocument,
): SourceDocumentInput {
  const isStudent = document.student_id !== null;
  return {
    academyId: document.academy_id,
    documentId: document.document_id,
    revision: document.revision,
    documentType: document.document_type as DocumentType,
    title: document.title,
    text: document.text,
    visibility: isStudent ? 'student_private' : 'academy_public',
    studentId: document.student_id,
    classId: document.class_id,
    validFrom: document.valid_from,
    validTo: document.valid_to,
    sourceId: document.source_id,
  };
}

export async function buildFixtureStore(
  data: FixtureData,
  store: InMemoryRagStore = new InMemoryRagStore(),
): Promise<InMemoryRagStore> {
  for (const document of data.documents) {
    const facts = data.facts
      .filter((fact) => fact.document_id === document.document_id)
      .map(toFactInput);
    const result = await store.upsertIndexedRevision({
      document: toDocumentInput(document),
      facts,
      approve: document.status === 'approved_active',
    });
    if (result.status === 'rejected' || result.status === 'failed') {
      throw new Error(
        `Fixture document rejected: ${document.document_id} (${result.errorCode})`,
      );
    }
  }
  return store;
}

export function buildFixtureCatalogs(
  data: FixtureData,
): Map<string, AcademyCatalog> {
  const catalogs = new Map<string, AcademyCatalog>();
  const academyIds = [
    ...new Set(data.documents.map((document) => document.academy_id)),
  ];
  for (const academyId of academyIds) {
    const documents = data.documents.filter(
      (document) =>
        document.academy_id === academyId &&
        document.status === 'approved_active',
    );
    const displayName =
      documents
        .map(
          (document) => document.title.match(/^([0-9A-Za-z가-힣]+학원)/)?.[1],
        )
        .find(Boolean) ?? academyId;
    const classes = new Map<string, string>();
    for (const document of documents) {
      if (!document.class_id || document.student_id) continue;
      const name = document.text.match(/(초|중|고)\d[가-힣]*반/)?.[0];
      if (name && !classes.has(document.class_id))
        classes.set(document.class_id, name);
    }
    const units = [
      ...new Set(
        data.facts
          .filter(
            (fact) =>
              fact.academy_id === academyId && fact.fact_type === 'accuracy',
          )
          .map((fact) => (fact.value as { unit: string }).unit),
      ),
    ];
    catalogs.set(academyId, {
      academyId,
      displayName,
      aliases: [],
      classes: [...classes].map(([classId, name]) => ({
        classId,
        name,
        aliases: [],
      })),
      units,
    });
  }
  return catalogs;
}

export function createFixtureCatalogPort(data: FixtureData): CatalogPort {
  const catalogs = buildFixtureCatalogs(data);
  return {
    async getAcademyCatalog(academyId) {
      return catalogs.get(academyId) ?? null;
    },
  };
}

const ORDINAL_ALIASES = [
  ['첫째', '큰애', '큰아이'],
  ['둘째', '작은애', '작은아이'],
  ['셋째'],
];

export function toAccessScope(user: FixtureUser): RagAccessScope {
  const multipleChildren =
    user.role === 'guardian' && user.allowed_student_ids.length > 1;
  return {
    actorId: user.user_id,
    academyId: user.academy_id,
    role: user.role,
    allowedStudentIds: [...user.allowed_student_ids],
    allowedClassIds: [...user.allowed_class_ids],
    studentRefs: user.allowed_student_ids.map((studentId, index) => {
      const code = studentId.replace(/^ST_/, '');
      return {
        studentId,
        displayLabel: code,
        aliases: [
          studentId,
          code,
          ...(multipleChildren ? (ORDINAL_ALIASES[index] ?? []) : []),
        ],
      };
    }),
    canViewPublicHistory: true,
  };
}

/** 모의 세션: { userId } → 권한. 테스트·로컬 dev 서버 전용. */
export function createFixtureAccessScopePort(
  data: FixtureData,
): AccessScopePort<{ userId: string }> {
  return {
    async resolveFromServerSession(session) {
      const user = data.users.find(
        (candidate) => candidate.user_id === session.userId,
      );
      return user ? toAccessScope(user) : null;
    },
  };
}

const MONTHS: Record<string, string> = {
  jan: '01',
  feb: '02',
  mar: '03',
  apr: '04',
  may: '05',
  jun: '06',
  jul: '07',
  aug: '08',
  sep: '09',
  oct: '10',
  nov: '11',
  dec: '12',
};
const UNIT_KEYS: Record<string, string> = {
  equation: '일차방정식',
  function: '함수',
};

/** 테스트 케이스의 session 필드 → 서버 대화 상태. */
export function toConversationState(
  session: Record<string, unknown>,
  asOfYear: number,
): ConversationState | null {
  const state: ConversationState = {};
  if (typeof session.selected_student_id === 'string')
    state.selectedStudentId = session.selected_student_id;
  if (Array.isArray(session.candidate_student_ids)) {
    state.candidateStudentIds = session.candidate_student_ids.filter(
      (id): id is string => typeof id === 'string',
    );
  }
  if (typeof session.selected_period === 'string')
    state.selectedPeriod = session.selected_period;
  if (typeof session.previous_question_type === 'string') {
    const match = session.previous_question_type.match(
      /^([a-z]{3})_([a-z]+)_accuracy$/,
    );
    if (match && MONTHS[match[1]] && UNIT_KEYS[match[2]]) {
      state.previousFrame = {
        domain: 'analysis',
        units: [UNIT_KEYS[match[2]]],
        periods: [`${asOfYear}-${MONTHS[match[1]]}`],
      };
    }
  }
  return Object.keys(state).length > 0 ? state : null;
}
