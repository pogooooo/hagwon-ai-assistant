import {
  createGenerationProviderFromEnv,
  type GenerationEnv,
} from '../rag-consultation/server/generation/from-env.ts';
import type { GenerationPort } from '../rag-consultation/server/ports.ts';
import type { OperationsDatabase } from './database.ts';

let provider: GenerationPort | undefined;
/** One provider per server: rate-limit and daily budget survive individual requests. */
export function operationsGeneration(): GenerationPort {
  return (provider ??= createGenerationProviderFromEnv({
    ...process.env,
    RAG_GENERATION_PROVIDER: 'clova',
    RAG_GENERATION_DAILY_CALL_LIMIT:
      process.env.RAG_GENERATION_DAILY_CALL_LIMIT ?? '100',
  }));
}

export function configureOperationsGeneration(generation: GenerationPort) {
  provider = generation;
}

export function createOperationsGeneration(
  env: GenerationEnv,
  fetchImpl?: typeof fetch,
  db?: OperationsDatabase,
) {
  const limit = Number(env.RAG_GENERATION_DAILY_CALL_LIMIT ?? '100');
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 1000)
    throw new Error('Invalid AI daily limit');
  db?.exec(
    'CREATE TABLE IF NOT EXISTS op_external_usage(day TEXT NOT NULL,kind TEXT NOT NULL,calls INTEGER NOT NULL,PRIMARY KEY(day,kind))',
  );
  const guardedFetch: typeof fetch = async (url, init) => {
    if (new URL(String(url)).origin !== 'https://clovastudio.stream.ntruss.com')
      throw new Error('Unsupported AI provider');
    if (
      db &&
      (limit === 0 ||
        !db
          .prepare(
            'INSERT INTO op_external_usage(day,kind,calls) VALUES(?,?,1) ON CONFLICT(day,kind) DO UPDATE SET calls=calls+1 WHERE calls<?',
          )
          .run(
            new Date().toISOString().slice(0, 10),
            'clova-consultation',
            limit,
          ).changes)
    )
      return new Response(null, { status: 402 });
    return (fetchImpl ?? fetch)(url, init);
  };
  return createGenerationProviderFromEnv(
    {
      ...env,
      RAG_GENERATION_PROVIDER:
        env.RAG_GENERATION_PROVIDER === 'disabled' ? 'disabled' : 'clova',
      RAG_GENERATION_DAILY_CALL_LIMIT: String(limit),
    },
    guardedFetch,
  );
}
