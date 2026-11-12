/**
 * 개발 전용 진단 도구(npm run rag:dev 에서만 사용). 운영 API·운영 응답에는 연결하지 않는다.
 * - 저장소 포트를 감싸 검색 호출(질의·순위·점수·신호)과 단계별 시간을 기록한다.
 * - 화면에서 고른 문서로만 검색·조회하도록 거른다(문서 선택 기능).
 */
import { splitIntoBlocks } from '../ingest/chunking.ts';
import { parseSourceFile } from '../ingest/parsers/index.ts';
import type {
  ApprovedFactsPort,
  ChunkSearchQuery,
  FactQuery,
  GenerationPort,
  RagDocumentsPort,
  ScoredChunk,
} from '../ports.ts';
import type { InMemoryRagStore } from '../store/in-memory-store.ts';

export interface SearchRecord {
  query: string;
  question?: string;
  documentTypes?: readonly string[];
  rerank?: string;
  ms: number;
  results: Array<{
    rank: number;
    chunkId: string;
    sourceId: string;
    documentId: string;
    title: string;
    section?: string;
    location: string;
    page?: number;
    score: number;
    signals?: ScoredChunk['signals'];
    text: string;
  }>;
}

export interface DevRecorder {
  searches: SearchRecord[];
  factQueries: Array<{
    factTypes: readonly string[];
    count: number;
    ms: number;
  }>;
  generation: { calls: number; ms: number };
}

const now = () => performance.now();

/**
 * 저장소를 감싼 포트. documentIds 가 있으면 그 문서의 청크·사실만 돌려준다.
 */
export function instrumentStore(
  store: InMemoryRagStore,
  recorder: DevRecorder,
  documentIds: readonly string[] | null,
): { facts: ApprovedFactsPort; documents: RagDocumentsPort } {
  const allowed = (documentId: string) =>
    !documentIds ||
    documentIds.length === 0 ||
    documentIds.includes(documentId);
  const facts: ApprovedFactsPort = {
    async queryApprovedFacts(query: FactQuery) {
      const started = now();
      const result = (await store.queryApprovedFacts(query)).filter((fact) =>
        allowed(fact.documentId),
      );
      recorder.factQueries.push({
        factTypes: query.factTypes ?? [],
        count: result.length,
        ms: now() - started,
      });
      return result;
    },
  };
  const documents: RagDocumentsPort = {
    async searchApprovedChunks(query: ChunkSearchQuery) {
      const started = now();
      const result = (await store.searchApprovedChunks(query)).filter((entry) =>
        allowed(entry.chunk.documentId),
      );
      recorder.searches.push({
        query: query.query,
        question: query.question,
        documentTypes: query.documentTypes,
        rerank: query.rerank,
        ms: now() - started,
        results: result.map((entry, index) => ({
          rank: index + 1,
          chunkId: entry.chunk.chunkId,
          sourceId: entry.chunk.sourceId,
          documentId: entry.chunk.documentId,
          title: entry.chunk.title,
          section: entry.chunk.location.section,
          location: entry.chunk.location.label,
          page: entry.chunk.location.page,
          score: Number(entry.score.toFixed(4)),
          signals: entry.signals,
          text: entry.chunk.text.slice(0, 240),
        })),
      });
      return result;
    },
    getCitableSource: (
      input: Parameters<RagDocumentsPort['getCitableSource']>[0],
    ) => store.getCitableSource(input),
    upsertIndexedRevision: (
      input: Parameters<RagDocumentsPort['upsertIndexedRevision']>[0],
    ) => store.upsertIndexedRevision(input),
    revokeRevision: (
      input: Parameters<RagDocumentsPort['revokeRevision']>[0],
    ) => store.revokeRevision(input),
    corpusContains: (
      input: Parameters<InMemoryRagStore['corpusContains']>[0],
    ) => store.corpusContains(input),
    factRefsAtChunk: (chunkId: string, academyId?: string) =>
      store.factRefsAtChunk(chunkId, academyId),
  };
  return { facts, documents };
}

/** 생성 공급자를 감싸 호출 수·시간을 기록한다(입력·출력 내용은 기록하지 않음). */
export function instrumentGeneration(
  generation: GenerationPort,
  recorder: DevRecorder,
): GenerationPort {
  return {
    providerId: generation.providerId,
    isExternal: generation.isExternal,
    personalDataApproved: generation.personalDataApproved,
    availability: (at) => generation.availability(at),
    async generateGroundedAnswer(input, options) {
      const started = now();
      try {
        return await generation.generateGroundedAnswer(input, options);
      } finally {
        recorder.generation.calls += 1;
        recorder.generation.ms += now() - started;
      }
    },
  };
}

/** 생성 공급자 종류(화면 표시용): 꺼짐 / 모의 / 실제 외부 API. */
export function generationMode(
  generation: GenerationPort,
): 'disabled' | 'mock' | 'real' {
  if (/disabled/i.test(generation.providerId)) return 'disabled';
  if (/mock/i.test(generation.providerId)) return 'mock';
  return generation.isExternal ? 'real' : 'mock';
}

/** 업로드 파일 파싱 미리 보기: 정규화 Markdown·쪽별 방식·경고·청크 위치. */
export async function previewParse(input: {
  fileName: string;
  bytes: Uint8Array;
}) {
  const parsed = await parseSourceFile({
    bytes: input.bytes,
    fileName: input.fileName,
    ocr: null,
  });
  const chunks =
    parsed.status === 'failed' || !parsed.text
      ? []
      : splitIntoBlocks(parsed.text).slice(0, 200);
  return {
    format: parsed.format,
    status: parsed.status,
    error: parsed.error,
    pages: parsed.pages,
    warnings: parsed.warnings,
    markdown: (parsed.text ?? '').slice(0, 60_000),
    chunks: chunks.map((block) => ({
      kind: block.location.kind,
      label: block.location.label,
      section: block.location.section,
      page: block.location.page,
      text: block.text.slice(0, 300),
    })),
  };
}
