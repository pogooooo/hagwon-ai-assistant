import { randomUUID } from 'node:crypto';

export interface ClovaUsage {
  requests: number;
  tokens: number;
  unreported: number;
}

export function createClovaApi(apiKey: string, fetchImpl = fetch) {
  if (!apiKey.trim()) throw new Error('RAG_CLOVA_API_KEY is required');
  const usage: ClovaUsage = { requests: 0, tokens: 0, unreported: 0 };
  return {
    usage: () => ({ ...usage }),
    async post(
      path: string,
      body: object,
      signal = AbortSignal.timeout(30_000),
    ): Promise<unknown> {
      usage.requests++;
      usage.unreported++;
      const response = await fetchImpl(
        'https://clovastudio.stream.ntruss.com' + path,
        {
          method: 'POST',
          redirect: 'error',
          headers: {
            Authorization: 'Bearer ' + apiKey.trim(),
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-NCP-CLOVASTUDIO-REQUEST-ID': randomUUID(),
          },
          body: JSON.stringify(body),
          signal,
        },
      );
      if (!response.ok) throw new Error('CLOVA HTTP ' + response.status);
      const data = (await response.json()) as {
        status?: { code?: string };
        result?: { usage?: { totalTokens?: number }; inputTokens?: number };
      };
      if (data?.status?.code !== '20000' || !data.result)
        throw new Error('Invalid CLOVA result');
      const tokens = data.result.usage?.totalTokens ?? data.result.inputTokens;
      if (
        typeof tokens === 'number' &&
        Number.isSafeInteger(tokens) &&
        tokens >= 0
      ) {
        usage.tokens += tokens;
        usage.unreported--;
      }
      return data.result;
    },
  };
}

export type ClovaApi = ReturnType<typeof createClovaApi>;
