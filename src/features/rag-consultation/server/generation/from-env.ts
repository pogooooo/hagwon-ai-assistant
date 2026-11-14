/**
 * 서버 환경 변수로 생성 공급자를 선택한다. 외부 키가 없으면 disabled.
 * 공급자는 인스턴스 생성 때 확정하며 요청 실패 시 다른 공급자로 전환하지 않는다.
 */
import type { GenerationPort } from '../ports.ts';
import {
  createOpenAICompatibleProvider,
  DisabledGenerationProvider,
  GuardedGenerationProvider,
  MockGenerationProvider,
  type OpenAICompatibleOptions,
} from './providers.ts';

export type GenerationEnv = Readonly<Record<string, string | undefined>>;

function externalOptions(
  env: GenerationEnv,
  provider: string,
): OpenAICompatibleOptions | undefined {
  const clovaKey = env.RAG_CLOVA_API_KEY?.trim();
  const geminiKey = env.RAG_GEMINI_API_KEY?.trim();

  if (clovaKey && (provider === 'auto' || provider === 'clova')) {
    const model = env.RAG_CLOVA_MODEL?.trim() || 'HCX-DASH-002';
    return {
      providerId: `clova:${model}`,
      baseUrl: 'https://clovastudio.stream.ntruss.com/v1/openai',
      model,
      apiKey: clovaKey,
      personalDataApproved: env.RAG_CLOVA_ALLOW_PERSONAL_DATA === 'true',
    };
  }
  if (geminiKey && (provider === 'auto' || provider === 'gemini')) {
    const model = env.RAG_GEMINI_MODEL?.trim() || 'gemini-3.5-flash-lite';
    return {
      providerId: `gemini:${model}`,
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model,
      apiKey: geminiKey,
      personalDataApproved: env.RAG_GEMINI_ALLOW_PERSONAL_DATA === 'true',
    };
  }
  if (provider === 'openai-compatible') {
    const {
      RAG_GENERATION_BASE_URL: baseUrl,
      RAG_GENERATION_MODEL: model,
      RAG_GENERATION_API_KEY: apiKey,
    } = env;
    if (baseUrl && model && apiKey)
      return {
        providerId: `openai-compatible:${model}`,
        baseUrl,
        model,
        apiKey,
        personalDataApproved: env.RAG_GENERATION_ALLOW_PERSONAL_DATA === 'true',
      };
  }
  return undefined;
}

export function createGenerationProviderFromEnv(
  env: GenerationEnv,
  fetchImpl?: typeof fetch,
): GenerationPort {
  const provider = (env.RAG_GENERATION_PROVIDER ?? 'gemini').trim();
  const dailyCallLimit = env.RAG_GENERATION_DAILY_CALL_LIMIT
    ? Number(env.RAG_GENERATION_DAILY_CALL_LIMIT)
    : undefined;
  if (
    dailyCallLimit !== undefined &&
    (!Number.isSafeInteger(dailyCallLimit) || dailyCallLimit < 0)
  )
    throw new Error(
      'RAG_GENERATION_DAILY_CALL_LIMIT must be a nonnegative integer',
    );
  if (provider === 'mock')
    return new GuardedGenerationProvider(new MockGenerationProvider('ok'), {
      dailyCallLimit,
    });
  const options = externalOptions(env, provider);
  return options
    ? new GuardedGenerationProvider(
        createOpenAICompatibleProvider({ ...options, fetchImpl }),
        { dailyCallLimit },
      )
    : new DisabledGenerationProvider();
}
