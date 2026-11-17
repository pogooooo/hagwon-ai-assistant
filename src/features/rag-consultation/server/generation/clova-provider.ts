import type { GenerationPort } from '../ports.ts';
import { buildUserPrompt, SYSTEM_RULES } from './prompt.ts';
import {
  DOCUMENT_READING_RULES,
  readingSchema,
} from '../answer/document-reading.ts';
import {
  PARENT_TEMPLATE_RULES,
  parentTemplateSchema,
} from './parent-template-prompt.ts';

/** Native CLOVA v3. No cross-provider retry; truncated JSON is never accepted. */
export function createClovaProvider(options: {
  apiKey: string;
  personalDataApproved: boolean;
  fetchImpl?: typeof fetch;
}): GenerationPort {
  const send = options.fetchImpl ?? fetch;
  return {
    providerId: 'clova:HCX-007',
    isExternal: true,
    personalDataApproved: options.personalDataApproved,
    availability: () => 'available',
    async generateGroundedAnswer(input, { timeoutMs }) {
      if (input.containsPersonalData && !options.personalDataApproved)
        return { ok: false, error: 'invalid_response' };
      const reading = input.mode === 'document-reading';
      const parentTemplate = input.mode === 'parent-template';
      try {
        const response = await send(
          'https://clovastudio.stream.ntruss.com/v3/chat-completions/HCX-007',
          {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(timeoutMs),
            headers: {
              Authorization: 'Bearer ' + options.apiKey,
              'Content-Type': 'application/json',
              'X-NCP-CLOVASTUDIO-REQUEST-ID': crypto.randomUUID(),
            },
            body: JSON.stringify({
              messages: [
                {
                  role: 'system',
                  content: parentTemplate
                    ? PARENT_TEMPLATE_RULES
                    : reading
                      ? DOCUMENT_READING_RULES
                      : SYSTEM_RULES,
                },
                {
                  role: 'user',
                  content: parentTemplate
                    ? JSON.stringify({ tone: input.question })
                    : reading
                      ? JSON.stringify({
                          question: input.question,
                          requirements: input.requirements,
                          documents: input.sources,
                        })
                      : buildUserPrompt(input),
                },
              ],
              temperature: 0,
              maxCompletionTokens: reading ? 2400 : 1200,
              thinking: { effort: 'none' },
              ...(parentTemplate
                ? {
                    responseFormat: {
                      type: 'json',
                      schema: parentTemplateSchema,
                    },
                  }
                : reading
                  ? {
                      responseFormat: {
                        type: 'json',
                        schema: {
                          ...readingSchema,
                          properties: {
                            ...readingSchema.properties,
                            items: {
                              ...readingSchema.properties.items,
                              minItems: input.requirements?.length ?? 1,
                              maxItems: input.requirements?.length ?? 8,
                              items: {
                                ...readingSchema.properties.items.items,
                                properties: {
                                  ...readingSchema.properties.items.items
                                    .properties,
                                  request: {
                                    type: 'string',
                                    enum: input.requirements,
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    }
                  : {}),
            }),
          },
        );
        if (response.status === 429) {
          const retry = Number(response.headers.get('retry-after'));
          return {
            ok: false,
            error: 'rate_limited',
            ...(retry > 0 && Number.isFinite(retry)
              ? { retryAfterMs: Math.min(retry, 86400) * 1000 }
              : {}),
          };
        }
        if (response.status === 402)
          return { ok: false, error: 'quota_exhausted' };
        if (response.status >= 500) return { ok: false, error: 'server_error' };
        if (!response.ok) return { ok: false, error: 'invalid_response' };
        const data = (await response.json()) as {
          status?: { code?: string };
          result?: { finishReason?: string; message?: { content?: unknown } };
        };
        const content = data.result?.message?.content;
        return data.status?.code === '20000' &&
          data.result?.finishReason === 'stop' &&
          typeof content === 'string'
          ? { ok: true, rawText: content }
          : { ok: false, error: 'invalid_response' };
      } catch (e) {
        return {
          ok: false,
          error:
            e instanceof Error &&
            ['AbortError', 'TimeoutError'].includes(e.name)
              ? 'timeout'
              : 'network_error',
        };
      }
    },
  };
}
