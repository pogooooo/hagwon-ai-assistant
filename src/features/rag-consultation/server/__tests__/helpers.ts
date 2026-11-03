import {
  buildFixtureStore,
  createFixtureCatalogPort,
  readFixtureData,
  toAccessScope,
  toConversationState,
  type FixtureCase,
  type FixtureData,
} from '../adapters/fixture/load-fixture.ts';
import {
  FixedClock,
  InMemoryConversationStore,
  InMemoryHandoffStore,
  MemoryRagLogger,
} from '../adapters/memory/index.ts';
import {
  GuardedGenerationProvider,
  MockGenerationProvider,
} from '../generation/providers.ts';
import {
  buildAcademiesStore,
  createAcademyCatalogPort,
  readAcademiesDataset,
  toAcademyAccessScope,
  type AcademiesDataset,
} from '../adapters/fixture/load-academies.ts';
import type { CatalogPort, GenerationPort } from '../ports.ts';
import {
  createRagConsultationService,
  type RagQueryOutput,
} from '../service.ts';
import type { InMemoryRagStore } from '../store/in-memory-store.ts';
import { parseInstant, toKstDate } from '../text/time.ts';
import type { RagAccessScope } from '../types.ts';

/** runQuery 가 필요로 하는 최소 환경(데이터셋 종류와 무관). */
export interface QueryEnv {
  store: InMemoryRagStore;
  catalog: CatalogPort;
  resolveScope: (userId: string) => RagAccessScope;
}

export interface TestEnv extends QueryEnv {
  data: FixtureData;
}

export interface AcademyEnv extends QueryEnv {
  dataset: AcademiesDataset;
}

let cached: Promise<TestEnv> | null = null;
let cachedAcademies: Promise<AcademyEnv> | null = null;

/** 읽기 전용 회귀 테스트용 공유 저장소(변경 테스트는 freshEnv 사용). */
export function sharedEnv(): Promise<TestEnv> {
  cached ??= freshEnv();
  return cached;
}

export async function freshEnv(): Promise<TestEnv> {
  const data = readFixtureData();
  const store = await buildFixtureStore(data);
  return {
    data,
    store,
    catalog: createFixtureCatalogPort(data),
    resolveScope: (userId) => scopeFor(data, userId),
  };
}

/** 가상 학원 3곳 자료(academies-v1) 공유 환경. */
export function academiesEnv(): Promise<AcademyEnv> {
  cachedAcademies ??= (async () => {
    const dataset = readAcademiesDataset();
    const store = await buildAcademiesStore(dataset);
    return {
      dataset,
      store,
      catalog: createAcademyCatalogPort(dataset),
      resolveScope: (userId: string) => {
        const user = dataset.users.find(
          (candidate) => candidate.user_id === userId,
        );
        if (!user) throw new Error(`unknown academy user ${userId}`);
        return toAcademyAccessScope(user, dataset.students);
      },
    };
  })();
  return cachedAcademies;
}

export function scopeFor(data: FixtureData, userId: string): RagAccessScope {
  const user = data.users.find((candidate) => candidate.user_id === userId);
  if (!user) throw new Error(`unknown fixture user ${userId}`);
  return toAccessScope(user);
}

/** 테스트 케이스의 api_state → 생성 공급자(사전 차단 상태 또는 호출 시 실패). */
export function generationFor(
  apiState: FixtureCase['input']['api_state'],
  now: number,
) {
  const mock = new MockGenerationProvider(
    apiState === 'timeout' ? 'timeout' : 'ok',
  );
  const guarded = new GuardedGenerationProvider(mock);
  if (apiState === '429') guarded.block('rate_limited', now + 60_000);
  if (apiState === '5xx') guarded.block('unavailable', now + 60_000);
  if (apiState === 'quota_exhausted')
    guarded.block('quota_exhausted', now + 86_400_000);
  return { mock, provider: guarded };
}

export interface RunOptions {
  engine?: 'legacy' | 'planned';
  userId: string;
  question: string;
  asOf: string;
  session?: Record<string, unknown>;
  generation?: GenerationPort;
  studentIdHint?: string;
  conversationId?: string;
  conversations?: InMemoryConversationStore;
  logger?: MemoryRagLogger;
  handoff?: InMemoryHandoffStore;
}

export async function runQuery(
  env: QueryEnv,
  options: RunOptions,
): Promise<RagQueryOutput & { generationCalls: number }> {
  const now = parseInstant(options.asOf);
  const access = env.resolveScope(options.userId);
  const conversations =
    options.conversations ?? new InMemoryConversationStore();
  const conversationId = options.conversationId ?? 'conv-test';
  if (options.session) {
    const state = toConversationState(options.session, toKstDate(now).year);
    if (state) await conversations.save(access.actorId, conversationId, state);
  }
  const { mock, provider } = options.generation
    ? { mock: null, provider: options.generation }
    : generationFor('ok', now);
  const service = createRagConsultationService({
    engine:
      options.engine ??
      (process.env.RAG_TEST_ENGINE === 'planned' ? 'planned' : 'legacy'),
    facts: env.store,
    documents: env.store,
    catalog: env.catalog,
    generation: provider,
    handoff: options.handoff ?? new InMemoryHandoffStore(),
    conversations,
    clock: new FixedClock(now),
    logger: options.logger,
  });
  const output = await service.query({
    access,
    question: options.question,
    studentIdHint: options.studentIdHint,
    conversationId,
  });
  return {
    ...output,
    generationCalls: mock ? mock.calls.length : output.trace.generationCalls,
  };
}
