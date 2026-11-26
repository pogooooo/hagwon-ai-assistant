/**
 * 4번 기능(파일 기반 RAG 상담) 서버 모듈 공개 진입점.
 *
 * ⚠️ 서버 전용. 웹/Capacitor 클라이언트 컴포넌트에서 import 하지 않는다.
 *    (클라이언트는 ../contract.ts 와 ../api/rag-client.ts 만 사용)
 */
export { createRagConsultationService } from './service.ts';
export type {
  RagConsultationDeps,
  RagConsultationService,
  RagQueryInput,
  RagQueryOutput,
} from './service.ts';
export { createRagHttpHandler } from './http/handlers.ts';
export type { RagHttpOptions } from './http/handlers.ts';
export { InMemoryTokenBucket } from './http/rate-limit.ts';
export type { RateLimiter } from './http/rate-limit.ts';
export { InMemoryRagStore } from './store/in-memory-store.ts';
export { IndexJobQueue } from './store/index-jobs.ts';
export type { IndexJob, IndexJobStatus } from './store/index-jobs.ts';
export {
  analysisReportToIndexInput,
  onAnalysisReportPublished,
  onDocumentChanged,
} from './events.ts';
export type {
  AnalysisReportPublished,
  DocumentChangedEvent,
} from './events.ts';
export {
  createOpenAICompatibleProvider,
  DisabledGenerationProvider,
  GuardedGenerationProvider,
  MockGenerationProvider,
} from './generation/providers.ts';
export { createGenerationProviderFromEnv } from './generation/from-env.ts';
export {
  ConsoleRagLogger,
  FixedClock,
  InMemoryConversationStore,
  InMemoryHandoffStore,
  MemoryRagLogger,
  SystemClock,
} from './adapters/memory/index.ts';
export { DEFAULT_RAG_CONFIG, DEFAULT_TOPICS } from './config.ts';
export type { RagConfig, TopicDefinition } from './config.ts';
export type * from './ports.ts';
export type * from './types.ts';
