/**
 * 환경 변수 → 생성 공급자. 키가 없거나 공급자가 미선정이면 disabled(정형 답변·검색·권한·검증은 계속 동작).
 * 실제 키는 서버 환경 변수로만 주입하며 NEXT_PUBLIC_ 접두어를 쓰지 않는다.
 */
import type { GenerationPort } from '../ports.ts';
import {
  createOpenAICompatibleProvider,
  DisabledGenerationProvider,
  GuardedGenerationProvider,
  MockGenerationProvider,
} from './providers.ts';

/** RAG_GENERATION_PROVIDER, _BASE_URL, _MODEL, _API_KEY, _ALLOW_PERSONAL_DATA, _DAILY_CALL_LIMIT */
export type GenerationEnv = Readonly<Record<string, string | undefined>>;

export function createGenerationProviderFromEnv(
  env: GenerationEnv,
): GenerationPort {
  const provider = (env.RAG_GENERATION_PROVIDER ?? 'disabled').trim();
  const dailyCallLimit = env.RAG_GENERATION_DAILY_CALL_LIMIT
    ? Number(env.RAG_GENERATION_DAILY_CALL_LIMIT)
    : undefined;
  if (provider === 'mock')
    return new GuardedGenerationProvider(new MockGenerationProvider('ok'), {
      dailyCallLimit,
    });
  if (provider === 'openai-compatible') {
    const {
      RAG_GENERATION_BASE_URL: baseUrl,
      RAG_GENERATION_MODEL: model,
      RAG_GENERATION_API_KEY: apiKey,
    } = env;
    if (!baseUrl || !model || !apiKey) return new DisabledGenerationProvider();
    return new GuardedGenerationProvider(
      createOpenAICompatibleProvider({
        providerId: `openai-compatible:${model}`,
        baseUrl,
        model,
        apiKey,
        personalDataApproved: env.RAG_GENERATION_ALLOW_PERSONAL_DATA === 'true',
      }),
      { dailyCallLimit },
    );
  }
  return new DisabledGenerationProvider();
}
