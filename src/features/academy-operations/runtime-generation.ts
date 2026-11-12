import {
  createGenerationProviderFromEnv,
  type GenerationEnv,
} from '../rag-consultation/server/generation/from-env.ts';
import type { GenerationPort } from '../rag-consultation/server/ports.ts';

let provider: GenerationPort | undefined;
/** One provider per server: rate-limit and daily budget survive individual requests. */
export function operationsGeneration(): GenerationPort {
  return (provider ??= createGenerationProviderFromEnv({
    ...process.env,
    RAG_GENERATION_PROVIDER: process.env.RAG_GENERATION_PROVIDER ?? 'gemini',
    RAG_GENERATION_DAILY_CALL_LIMIT:
      process.env.RAG_GENERATION_DAILY_CALL_LIMIT ?? '100',
  }));
}
export function createOperationsGeneration(
  env: GenerationEnv,
  fetchImpl?: typeof fetch,
) {
  return createGenerationProviderFromEnv(env, fetchImpl);
}
