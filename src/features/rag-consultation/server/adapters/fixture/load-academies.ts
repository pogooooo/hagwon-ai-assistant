/**
 * 가상 학원 3곳 테스트 자료(academies-v1) → 저장소·카탈로그·모의 세션 어댑터.
 *
 * ⚠️ 테스트·로컬 개발 전용. users.json 계정을 "모의 서버 세션"으로 바꾸는 것은
 *    테스트 러너와 dev 서버에서만 허용된다.
 * 형식은 __fixtures__/academies-v1/FORMAT.md 참고.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { AccessScopePort, CatalogPort } from '../../ports.ts';
import { InMemoryRagStore } from '../../store/in-memory-store.ts';
import type {
  AcademyCatalog,
  ApprovedFactInput,
  DocumentType,
  FactType,
  FactValue,
  RagAccessScope,
  RagRole,
  SourceDocumentInput,
  Visibility,
} from '../../types.ts';

export const ACADEMIES_DIR = join(
  import.meta.dirname,
  '..',
  '..',
  '__fixtures__',
  'academies-v1',
);

export interface AcademyJson {
  academy_id: string;
  display_name: string;
  aliases: string[];
  classes: Array<{
    class_id: string;
    name: string;
    aliases: string[];
    subject?: string;
    grade?: string;
  }>;
  units: string[];
  question_types: string[];
}

export interface AcademyUserJson {
  user_id: string;
  role: RagRole;
  academy_id: string;
  allowed_student_ids: string[];
  allowed_class_ids: string[];
  student_aliases?: Record<string, string[]>;
}

export interface StudentJson {
  student_id: string;
  academy_id: string;
  name: string;
  aliases: string[];
  class_ids: string[];
}

export interface AcademyDocument {
  meta: {
    document_id: string;
    revision: number;
    document_type: string;
    title: string;
    status: 'approved_active' | 'draft';
    visibility: string;
    class_id: string | null;
    student_id: string | null;
    valid_from: string;
    valid_to: string | null;
    approved_at: string | null;
  };
  body: string;
  file: string;
}

export interface AcademyFactJson {
  fact_id: string;
  document_id: string;
  revision: number;
  academy_id: string;
  subject_type: 'student' | 'class' | 'academy';
  subject_id: string;
  fact_type: string;
  value: Record<string, unknown>;
  period: string | null;
  valid_from: string;
  valid_to: string | null;
  assignments?: Array<{ assignment_id: string; title: string }>;
  evidence?: string | null;
}

export interface AcademyCase {
  case_id: string;
  split: 'dev' | 'holdout';
  category: string;
  tags?: string[];
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
    must_include?: string[];
    must_not_include?: string[];
    notes?: string;
  };
}

export interface AcademiesDataset {
  academies: AcademyJson[];
  users: AcademyUserJson[];
  students: StudentJson[];
  documents: AcademyDocument[];
  facts: AcademyFactJson[];
  cases: AcademyCase[];
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

function readJsonl<T>(path: string): T[] {
  try {
    return readFileSync(path, 'utf-8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as T);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** validate_academies.py 와 같은 규칙의 front matter 파서(값은 JSON 으로 해석되면 JSON, 아니면 문자열). */
export function parseFrontMatter(raw: string): {
  meta: Record<string, unknown>;
  body: string;
} {
  const text = raw.replace(/\r\n?/g, '\n');
  if (!text.startsWith('---\n')) throw new Error('front matter 없음');
  const end = text.indexOf('\n---\n', 4);
  if (end < 0) throw new Error('front matter 종료 없음');
  const meta: Record<string, unknown> = {};
  for (const line of text.slice(4, end).split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const index = line.indexOf(':');
    if (index < 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (value.includes(' #')) value = value.split(' #')[0].trim();
    if (value === '' || value === 'null' || value === '~') {
      meta[key] = null;
      continue;
    }
    try {
      meta[key] = JSON.parse(value);
    } catch {
      meta[key] = value;
    }
  }
  return { meta, body: text.slice(end + 5) };
}

export function readAcademiesDataset(
  dir: string = ACADEMIES_DIR,
): AcademiesDataset {
  const dataset: AcademiesDataset = {
    academies: [],
    users: [],
    students: [],
    documents: [],
    facts: [],
    cases: [],
  };
  const folders = readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .filter((name) => {
      try {
        return statSync(join(dir, name, 'academy.json')).isFile();
      } catch {
        return false;
      }
    })
    .sort();
  for (const folder of folders) {
    const base = join(dir, folder);
    dataset.academies.push(readJson<AcademyJson>(join(base, 'academy.json')));
    dataset.users.push(
      ...readJson<AcademyUserJson[]>(join(base, 'users.json')),
    );
    dataset.students.push(
      ...readJson<StudentJson[]>(join(base, 'students.json')),
    );
    for (const file of readdirSync(join(base, 'documents'))
      .filter((name) => name.endsWith('.md'))
      .sort()) {
      const { meta, body } = parseFrontMatter(
        readFileSync(join(base, 'documents', file), 'utf-8'),
      );
      dataset.documents.push({
        meta: meta as AcademyDocument['meta'],
        body,
        file: `${folder}/documents/${file}`,
      });
    }
    dataset.facts.push(
      ...readJsonl<AcademyFactJson>(join(base, 'facts.jsonl')),
    );
    dataset.cases.push(...readJsonl<AcademyCase>(join(base, 'cases.jsonl')));
  }
  return dataset;
}

export function sourceIdOf(meta: {
  document_id: string;
  revision: number;
}): string {
  return `${meta.document_id}:r${meta.revision}:body`;
}

function toFactValue(fact: AcademyFactJson): FactValue {
  const v = fact.value;
  switch (v.kind) {
    case 'money':
      return { kind: 'money', amount: Number(v.amount), currency: 'KRW' };
    case 'schedule':
      return { kind: 'schedule', text: String(v.text) };
    case 'enrollment':
      return {
        kind: 'enrollment',
        status: v.status as 'open' | 'waitlist' | 'closed',
        capacity: typeof v.capacity === 'number' ? v.capacity : null,
        remaining: typeof v.remaining === 'number' ? v.remaining : null,
        text: String(v.text),
      };
    case 'schedule_change':
      return {
        kind: 'schedule_change',
        changeType: v.change_type as 'cancel' | 'makeup',
        date: String(v.date),
        time: typeof v.time === 'string' ? v.time : null,
        text: String(v.text),
      };
    case 'accuracy':
      return {
        kind: 'accuracy',
        correct: Number(v.correct),
        total: Number(v.total),
        unit: String(v.unit),
        dimension:
          (v.dimension as 'unit' | 'question_type' | 'overall' | undefined) ??
          'unit',
      };
    case 'weak_area':
      return { kind: 'weak_area', unit: String(v.unit), text: String(v.text) };
    default:
      return { kind: 'text', text: String(v.text ?? '') };
  }
}

export function toAcademyFactInput(fact: AcademyFactJson): ApprovedFactInput {
  return {
    factId: fact.fact_id,
    sourceId: sourceIdOf({
      document_id: fact.document_id,
      revision: fact.revision,
    }),
    documentId: fact.document_id,
    revision: fact.revision,
    academyId: fact.academy_id,
    subjectType: fact.subject_type,
    subjectId: fact.subject_id,
    factType: fact.fact_type as FactType,
    value: toFactValue(fact),
    period: fact.period,
    validFrom: fact.valid_from,
    validTo: fact.valid_to,
    approvalStatus: 'approved',
    assignments: (fact.assignments ?? []).map((a) => ({
      assignmentId: a.assignment_id,
      title: a.title,
    })),
    evidence: fact.evidence ?? null,
  };
}

export function toAcademyDocumentInput(
  document: AcademyDocument,
): SourceDocumentInput {
  const { meta } = document;
  return {
    academyId: document.file.split('/')[0],
    documentId: meta.document_id,
    revision: meta.revision,
    documentType: meta.document_type as DocumentType,
    title: meta.title,
    text: document.body,
    visibility: meta.visibility as Visibility,
    studentId: meta.student_id,
    classId: meta.class_id,
    validFrom: meta.valid_from,
    validTo: meta.valid_to,
    approvedAt: meta.approved_at,
    sourceId: sourceIdOf(meta),
  };
}

export async function buildAcademiesStore(
  dataset: AcademiesDataset,
  store: InMemoryRagStore = new InMemoryRagStore(),
): Promise<InMemoryRagStore> {
  const ordered = [...dataset.documents].sort(
    (a, b) =>
      a.meta.document_id.localeCompare(b.meta.document_id) ||
      a.meta.revision - b.meta.revision,
  );
  for (const document of ordered) {
    const facts = dataset.facts
      .filter(
        (fact) =>
          fact.document_id === document.meta.document_id &&
          fact.revision === document.meta.revision,
      )
      .map(toAcademyFactInput);
    const result = await store.upsertIndexedRevision({
      document: toAcademyDocumentInput(document),
      facts,
      approve: document.meta.status === 'approved_active',
    });
    if (result.status === 'rejected' || result.status === 'failed') {
      throw new Error(
        `학원 자료 색인 실패: ${document.file} (${result.errorCode})`,
      );
    }
  }
  return store;
}

export function buildAcademyCatalogs(
  dataset: AcademiesDataset,
): Map<string, AcademyCatalog> {
  const catalogs = new Map<string, AcademyCatalog>();
  for (const academy of dataset.academies) {
    catalogs.set(academy.academy_id, {
      academyId: academy.academy_id,
      displayName: academy.display_name,
      aliases: academy.aliases,
      classes: academy.classes.map((klass) => ({
        classId: klass.class_id,
        name: klass.name,
        aliases: klass.aliases,
        subject: klass.subject,
        grade: klass.grade,
      })),
      units: academy.units,
      questionTypes: academy.question_types,
      studentDirectory: dataset.students
        .filter((student) => student.academy_id === academy.academy_id)
        .map((student) => ({
          studentId: student.student_id,
          names: [student.name, ...student.aliases],
        })),
    });
  }
  return catalogs;
}

export function createAcademyCatalogPort(
  dataset: AcademiesDataset,
): CatalogPort {
  const catalogs = buildAcademyCatalogs(dataset);
  return {
    async getAcademyCatalog(academyId) {
      return catalogs.get(academyId) ?? null;
    },
  };
}

export function toAcademyAccessScope(
  user: AcademyUserJson,
  students: StudentJson[],
): RagAccessScope {
  return {
    actorId: user.user_id,
    academyId: user.academy_id,
    role: user.role,
    allowedStudentIds: [...user.allowed_student_ids],
    allowedClassIds: [...user.allowed_class_ids],
    studentRefs: user.allowed_student_ids.map((studentId) => {
      const student = students.find(
        (candidate) => candidate.student_id === studentId,
      );
      return {
        studentId,
        displayLabel: student?.name ?? studentId,
        aliases: [
          studentId,
          ...(student ? [student.name, ...student.aliases] : []),
          ...(user.student_aliases?.[studentId] ?? []),
        ],
        classIds: student?.class_ids ?? [],
      };
    }),
    canViewPublicHistory: true,
  };
}

/** 모의 세션: { userId } → 권한. 테스트·로컬 dev 서버 전용. */
export function createAcademyAccessScopePort(
  dataset: AcademiesDataset,
): AccessScopePort<{ userId: string }> {
  return {
    async resolveFromServerSession(session) {
      const user = dataset.users.find(
        (candidate) => candidate.user_id === session.userId,
      );
      return user ? toAcademyAccessScope(user, dataset.students) : null;
    },
  };
}
