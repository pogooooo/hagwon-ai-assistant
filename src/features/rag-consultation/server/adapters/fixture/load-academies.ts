/**
 * 가상 학원 3곳 테스트 자료(academies-v1) → 저장소·카탈로그·모의 세션 어댑터.
 *
 * ⚠️ 테스트·로컬 개발 전용. users.json 계정을 "모의 서버 세션"으로 바꾸는 것은
 *    테스트 러너와 dev 서버에서만 허용된다.
 * 형식은 __fixtures__/academies-v1/FORMAT.md 참고.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';

import { prepareFileDocument } from '../../ingest/ingest-file.ts';
import {
  PARSER_VERSION,
  type OcrEngine,
  type ParsedFile,
  type SourceFormat,
} from '../../ingest/parsers/index.ts';

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

type AcademySourceFormat = SourceFormat | 'pdf_text' | 'pdf_scan';

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
  /** 원본 파일을 등록 파서로 처리한다. 본문이 제공되는 자료는 source 가 없다. */
  source?: {
    path: string;
    fileName: string;
    format: AcademySourceFormat;
  };
  /** v2 메타의 render 정보(시험 자료 생성 조건) */
  render?: {
    format: string;
    layout?: string;
    rotate?: number;
    scan_quality?: string | null;
  };
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
  split: 'dev' | 'holdout' | 'test';
  category: string;
  tags?: string[];
  input: {
    user_id: string;
    query: string;
    as_of: string;
    session: Record<string, unknown>;
    api_state: 'ok' | '429' | '5xx' | 'timeout' | 'quota_exhausted';
    /** v2: 같은 대화에서 먼저 보낸 질문 */
    history?: Array<{ query: string }>;
  };
  expected: {
    status: string;
    fact_ids?: string[];
    source_ids: string[];
    generation_budget_max: number;
    must_include?: string[];
    must_not_include?: string[];
    /** v2: 함께 허용하는 결과 */
    alternatives?: Array<{ status: string; must_include?: string[] }>;
    evidence_quote?: string;
    evidence_location?: string;
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

const rawFormats = new Map<string, SourceFormat>([
  ['.pdf', 'pdf'],
  ['.txt', 'txt'],
  ['.text', 'txt'],
  ['.csv', 'txt'],
  ['.docx', 'docx'],
  ['.hwpx', 'hwpx'],
  ['.md', 'markdown'],
  ['.markdown', 'markdown'],
]);

function readDocumentSource(
  directory: string,
  folder: string,
  manifest: string,
): AcademyDocument {
  const meta = readJson<
    AcademyDocument['meta'] & {
      file_name?: string;
      source_file?: string;
      render?: AcademyDocument['render'];
    }
  >(join(directory, manifest));
  const stem = manifest.slice(0, -'.meta.json'.length);
  const legacy = meta.render?.format;
  const legacyExtension =
    legacy === 'pdf_text' || legacy === 'pdf_scan'
      ? '.pdf'
      : legacy === 'txt'
        ? '.txt'
        : undefined;
  const raw =
    meta.source_file ?? (legacyExtension ? stem + legacyExtension : '');
  const format =
    typeof raw === 'string'
      ? rawFormats.get(extname(raw).toLowerCase())
      : undefined;
  if (!format || /[\\/:]/.test(raw))
    throw new Error('지원되는 원본 파일 이름이 필요합니다 (' + manifest + ')');
  const sourcePath = join(directory, raw);
  if (!existsSync(sourcePath) || !statSync(sourcePath).isFile())
    throw new Error('원본 파일 없음: ' + folder + '/documents/' + raw);
  const recordedFormat =
    format === 'pdf' && (legacy === 'pdf_scan' || legacy === 'pdf_text')
      ? legacy
      : format;
  return {
    meta,
    body: '',
    file: folder + '/documents/' + raw,
    source: {
      path: sourcePath,
      fileName: meta.file_name ?? raw,
      format: recordedFormat,
    },
    render: meta.render,
  };
}

export function readAcademiesDataset(
  dir: string = ACADEMIES_DIR,
  options: { folders?: readonly string[] } = {},
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
    .filter((name) => !options.folders || options.folders.includes(name))
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
    const directory = join(base, 'documents');
    const files = readdirSync(directory).sort();
    const raw = files
      .filter((name) => name.endsWith('.meta.json'))
      .map((name) => readDocumentSource(directory, folder, name));
    const sourceFiles = new Set(raw.map(({ source }) => source?.path));
    for (const file of files.filter(
      (name) => name.endsWith('.md') && !sourceFiles.has(join(directory, name)),
    )) {
      const { meta, body } = parseFrontMatter(
        readFileSync(join(directory, file), 'utf-8'),
      );
      dataset.documents.push({
        meta: meta as AcademyDocument['meta'],
        body,
        file: `${folder}/documents/${file}`,
      });
    }
    dataset.documents.push(...raw);
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

/** 파싱 결과 캐시(파일·파서 버전·OCR 실행 조건별로 분리). 평가 반복 실행용. */
function parseCacheDir(): string {
  return join(
    process.env.RAG_MODEL_CACHE_DIR ??
      join(homedir(), '.cache', 'axr-rag-models'),
    'parse-cache',
  );
}

export interface BuildStoreOptions {
  /** OCR 엔진(없으면 필요할 때 tesseract.js). null 이면 OCR 끔 */
  ocr?: OcrEngine | null;
  /** 파싱 결과 캐시 사용(기본 true) */
  cache?: boolean;
  /** 문서별 파싱 결과를 받는다(파싱 정확도 보고용) */
  onParsed?: (
    document: AcademyDocument,
    parsed: ParsedFile,
    cached: boolean,
  ) => void;
}

async function documentInput(
  document: AcademyDocument,
  options: BuildStoreOptions,
): Promise<SourceDocumentInput> {
  const base = toAcademyDocumentInput(document);
  if (!document.source) return base;
  const bytes = new Uint8Array(readFileSync(document.source.path));
  const ocrMode =
    options.ocr === undefined
      ? 'auto:tesseract.js:kor+eng'
      : options.ocr === null
        ? 'disabled'
        : `custom:${options.ocr.id}`;
  const key = createHash('sha256')
    .update(JSON.stringify([PARSER_VERSION, document.source.fileName, ocrMode]))
    .update(bytes)
    .digest('hex');
  const cachePath = join(parseCacheDir(), `${key}.json`);
  const { text: _text, ...meta } = base;
  void _text;
  if (options.cache !== false && existsSync(cachePath)) {
    const parsed = JSON.parse(readFileSync(cachePath, 'utf-8')) as ParsedFile;
    options.onParsed?.(document, parsed, true);
    return withParsed(meta, parsed, document.source.fileName);
  }
  const prepared = await prepareFileDocument(
    meta,
    { bytes, fileName: document.source.fileName },
    { ocr: options.ocr },
  );
  options.onParsed?.(document, prepared.parsed, false);
  // 일시적 OCR 장애·빈 결과를 저장해 다음 실행의 복구를 막지 않는다.
  if (
    options.cache !== false &&
    prepared.document &&
    !prepared.parsed.warnings.some(
      (warning) => warning.code === 'ocr_unavailable',
    )
  ) {
    mkdirSync(parseCacheDir(), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(prepared.parsed));
  }
  if (!prepared.document)
    throw new Error(
      `원본 파싱 실패: ${document.file} (${prepared.parsed.error})`,
    );
  return prepared.document;
}

function withParsed(
  meta: Omit<SourceDocumentInput, 'text'>,
  parsed: ParsedFile,
  fileName: string,
): SourceDocumentInput {
  if (parsed.status === 'failed')
    throw new Error(
      `원본 파싱 실패(캐시): ${meta.documentId} (${parsed.error})`,
    );
  return {
    ...meta,
    text: parsed.text,
    extraction: {
      fileName,
      format: parsed.format,
      status: parsed.status,
      pages: parsed.pages,
      warnings: parsed.warnings.map((w) =>
        [w.code, w.page ? `p${w.page}` : null, w.detail]
          .filter(Boolean)
          .join(':'),
      ),
    },
  };
}

export async function buildAcademiesStore(
  dataset: AcademiesDataset,
  store: InMemoryRagStore = new InMemoryRagStore(),
  options: BuildStoreOptions = {},
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
      document: await documentInput(document, options),
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
