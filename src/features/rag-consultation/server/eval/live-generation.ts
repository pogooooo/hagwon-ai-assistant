/** Explicit evaluation modes share the production adapter without changing its privacy policy. */
import {
  createGenerationProviderFromEnv,
  type GenerationEnv,
} from '../generation/from-env.ts';
import type { GenerationPort } from '../ports.ts';

export type LiveGenerationMode = 'gemini' | 'gemini-synthetic';

export function createEvalGemini(
  mode: LiveGenerationMode,
  maxLiveCalls: number,
  env: GenerationEnv,
  fetchImpl: typeof fetch = fetch,
) {
  if (!Number.isSafeInteger(maxLiveCalls) || maxLiveCalls <= 0)
    throw new Error('Gemini evaluation requires a positive --max-live-calls');

  let liveRequests = 0;
  let httpFailures = 0;
  let transportFailures = 0;
  let budgetBlocks = 0;
  let authorizationFailed = false;
  const client = createGenerationProviderFromEnv(
    { ...env, RAG_GENERATION_PROVIDER: 'gemini' },
    async (url, options) => {
      if (liveRequests >= maxLiveCalls)
        return new Response(null, { status: 402 });
      if (authorizationFailed) return new Response(null, { status: 403 });

      liveRequests += 1;
      try {
        const response = await fetchImpl(url, options);
        if (!response.ok) httpFailures += 1;
        if (response.status === 401 || response.status === 403)
          authorizationFailed = true;
        return response;
      } catch (error) {
        transportFailures += 1;
        throw error;
      }
    },
  );
  if (!client.isExternal || !client.providerId.startsWith('gemini:'))
    throw new Error('Gemini evaluation requires RAG_GEMINI_API_KEY');

  const synthetic = mode === 'gemini-synthetic';
  const provider: GenerationPort = {
    providerId: client.providerId,
    isExternal: true,
    personalDataApproved: synthetic,
    availability() {
      if (authorizationFailed) return 'unavailable';
      if (liveRequests >= maxLiveCalls) {
        budgetBlocks += 1;
        return 'quota_exhausted';
      }
      return client.availability(Date.now());
    },
    generateGroundedAnswer(input, options) {
      // The CLI permits this path only for the repository's synthetic suites.
      return client.generateGroundedAnswer(
        synthetic ? { ...input, containsPersonalData: false } : input,
        { ...options, now: Date.now() },
      );
    },
  };
  return {
    provider,
    report: () => ({
      mode,
      providerId: provider.providerId,
      maxLiveCalls,
      liveRequests,
      httpFailures,
      transportFailures,
      budgetBlocks,
      authorizationFailed,
    }),
  };
}
