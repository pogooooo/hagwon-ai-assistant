/**
 * 생성 공급자 어댑터.
 * - DisabledGenerationProvider: 공급자 미선정 상태(기본값). 생성이 필요한 질문은 담당자 연결.
 * - MockGenerationProvider: 합성 데이터 테스트용(외부 전송 없음).
 * - GuardedGenerationProvider: 429/5xx/타임아웃/쿼터 소진 시 호출 전 차단하는 회로 차단기.
 * - createOpenAICompatibleProvider: CLOVA Studio·Gemini 등 OpenAI 호환 API의 서버 전용 HTTP 어댑터.
 *
 * 다른 공급자로의 자동 전환은 하지 않는다(개인정보 처리 정책이 다른 곳으로 데이터가 흘러갈 수 있음).
 */
import type {
  GenerationAvailability,
  GenerationInput,
  GenerationPort,
  GenerationResult,
} from '../ports.ts';
import { buildUserPrompt, SYSTEM_RULES } from './prompt.ts';

export class DisabledGenerationProvider implements GenerationPort {
  readonly providerId = 'disabled';
  readonly isExternal = false;
  readonly personalDataApproved = false;

  availability(): GenerationAvailability {
    return 'disabled';
  }

  async generateGroundedAnswer(): Promise<GenerationResult> {
    return { ok: false, error: 'server_error' };
  }
}

export type MockGenerationBehavior =
  | 'ok'
  | 'rate_limited'
  | 'server_error'
  | 'timeout'
  | 'quota_exhausted'
  | 'invalid_json'
  | 'fake_citation'
  | 'unsupported_number'
  | 'mentions_other_student'
  | 'forbidden_claim'
  | 'unknown';

/** 입력 사실만 그대로 인용하는 결정적 mock. 생성 품질 평가용이 아니라 파이프라인 검증용이다. */
export class MockGenerationProvider implements GenerationPort {
  readonly providerId = 'mock';
  readonly isExternal = false;
  readonly personalDataApproved = true;
  readonly calls: GenerationInput[] = [];
  behavior: MockGenerationBehavior;

  constructor(behavior: MockGenerationBehavior = 'ok') {
    this.behavior = behavior;
  }

  availability(): GenerationAvailability {
    return 'available';
  }

  async generateGroundedAnswer(
    input: GenerationInput,
  ): Promise<GenerationResult> {
    this.calls.push(input);
    const sourceIds = [...new Set(input.facts.map((fact) => fact.sourceId))];
    const summary = input.facts
      .map((fact) => `${fact.period ?? ''} ${fact.valueText}`.trim())
      .join(', ');
    const body = (answer: string, cited = sourceIds) =>
      JSON.stringify({
        status: 'answered',
        answer,
        cited_source_ids: cited,
        missing_fields: [],
      });
    switch (this.behavior) {
      case 'ok':
        return {
          ok: true,
          rawText: body(
            `확정된 기록(${summary})을 기준으로 정답률이 상대적으로 낮은 단원부터 복습하는 방향을 권해 드립니다. 구체적인 학습 계획은 담당 강사와 함께 정하시는 것이 좋습니다.`,
          ),
        };
      case 'rate_limited':
        return { ok: false, error: 'rate_limited', retryAfterMs: 30_000 };
      case 'server_error':
        return { ok: false, error: 'server_error' };
      case 'timeout':
        return { ok: false, error: 'timeout' };
      case 'quota_exhausted':
        return { ok: false, error: 'quota_exhausted' };
      case 'invalid_json':
        return { ok: true, rawText: '정답률이 낮은 단원을 복습하세요.' };
      case 'fake_citation':
        return {
          ok: true,
          rawText: body('복습을 권합니다.', ['DOC_PRIVATE:secret']),
        };
      case 'unsupported_number':
        return {
          ok: true,
          rawText: body('다음 달에는 정답률이 95%까지 오를 것입니다.'),
        };
      case 'mentions_other_student':
        return {
          ok: true,
          rawText: body('ST_B01 학생보다 정답률이 낮습니다.'),
        };
      case 'forbidden_claim':
        return {
          ok: true,
          rawText: body('집중력이 부족하기 때문에 정답률이 낮습니다.'),
        };
      case 'unknown':
        return {
          ok: true,
          rawText: JSON.stringify({
            status: 'unknown',
            answer: '',
            cited_source_ids: [],
            missing_fields: [],
          }),
        };
      default:
        return { ok: false, error: 'server_error' };
    }
  }
}

export interface GuardOptions {
  /** 연속 5xx/타임아웃 몇 번이면 차단할지 */
  failureThreshold?: number;
  /** 5xx/타임아웃 차단 유지 시간 */
  cooldownMs?: number;
  /** 429 에 Retry-After 가 없을 때 기본 대기 */
  defaultRetryAfterMs?: number;
  /** 쿼터 소진 시 다음 초기화 시각 계산(기본: 다음 UTC 0시) */
  nextQuotaReset?: (now: number) => number;
  /** 하루 최대 생성 호출(무료 한도 보호). 없으면 제한 없음. */
  dailyCallLimit?: number;
}

/** 호출 전 가용성 판단 + 실패 기록. 재시도 루프는 두지 않는다. */
export class GuardedGenerationProvider implements GenerationPort {
  readonly providerId: string;
  readonly isExternal: boolean;
  readonly personalDataApproved: boolean;
  private readonly inner: GenerationPort;
  private readonly options: Required<Omit<GuardOptions, 'dailyCallLimit'>> & {
    dailyCallLimit?: number;
  };
  private blockedUntil = 0;
  private blockedReason: GenerationAvailability = 'available';
  private consecutiveFailures = 0;
  private callDay = '';
  private callsToday = 0;

  constructor(inner: GenerationPort, options: GuardOptions = {}) {
    this.inner = inner;
    this.providerId = inner.providerId;
    this.isExternal = inner.isExternal;
    this.personalDataApproved = inner.personalDataApproved;
    this.options = {
      failureThreshold: options.failureThreshold ?? 2,
      cooldownMs: options.cooldownMs ?? 60_000,
      defaultRetryAfterMs: options.defaultRetryAfterMs ?? 60_000,
      nextQuotaReset:
        options.nextQuotaReset ??
        ((now) => {
          const date = new Date(now);
          return Date.UTC(
            date.getUTCFullYear(),
            date.getUTCMonth(),
            date.getUTCDate() + 1,
          );
        }),
      dailyCallLimit: options.dailyCallLimit,
    };
  }

  /** 외부 모니터링/설정으로 알려진 장애 상태를 주입한다. */
  block(reason: Exclude<GenerationAvailability, 'available'>, until: number) {
    this.blockedReason = reason;
    this.blockedUntil = until;
  }

  availability(now: number): GenerationAvailability {
    if (now < this.blockedUntil) return this.blockedReason;
    const day = new Date(now).toISOString().slice(0, 10);
    if (
      this.options.dailyCallLimit !== undefined &&
      day === this.callDay &&
      this.callsToday >= this.options.dailyCallLimit
    ) {
      return 'quota_exhausted';
    }
    return this.inner.availability(now);
  }

  async generateGroundedAnswer(
    input: GenerationInput,
    options: { timeoutMs: number; now: number },
  ): Promise<GenerationResult> {
    const { now } = options;
    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== this.callDay) {
      this.callDay = day;
      this.callsToday = 0;
    }
    this.callsToday += 1;
    const result = await this.inner.generateGroundedAnswer(input, options);
    if (result.ok) {
      this.consecutiveFailures = 0;
      return result;
    }
    switch (result.error) {
      case 'rate_limited':
        this.block(
          'rate_limited',
          now + (result.retryAfterMs ?? this.options.defaultRetryAfterMs),
        );
        break;
      case 'quota_exhausted':
        this.block('quota_exhausted', this.options.nextQuotaReset(now));
        break;
      case 'server_error':
      case 'timeout':
      case 'network_error':
        this.consecutiveFailures += 1;
        if (this.consecutiveFailures >= this.options.failureThreshold) {
          this.block('unavailable', now + this.options.cooldownMs);
        }
        break;
      default:
        break;
    }
    return result;
  }
}

export interface OpenAICompatibleOptions {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 약관·미성년 이용·국외 처리 검토 완료 전에는 false 유지 */
  personalDataApproved?: boolean;
  fetchImpl?: typeof fetch;
  maxOutputTokens?: number;
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

export function createOpenAICompatibleProvider(
  options: OpenAICompatibleOptions,
): GenerationPort {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = `${options.baseUrl.replace(/\/$/, '')}/chat/completions`;
  return {
    providerId: options.providerId,
    isExternal: true,
    personalDataApproved: options.personalDataApproved ?? false,
    availability: () => 'available',
    async generateGroundedAnswer(input, { timeoutMs }) {
      if (input.containsPersonalData && !options.personalDataApproved)
        return { ok: false, error: 'invalid_response' };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({
            model: options.model,
            temperature: 0,
            max_tokens: options.maxOutputTokens ?? 400,
            messages: [
              { role: 'system', content: SYSTEM_RULES },
              { role: 'user', content: buildUserPrompt(input) },
            ],
          }),
        });
        if (response.status === 429) {
          return {
            ok: false,
            error: 'rate_limited',
            retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
          };
        }
        if (response.status === 402)
          return { ok: false, error: 'quota_exhausted' };
        if (response.status >= 500) return { ok: false, error: 'server_error' };
        if (!response.ok) return { ok: false, error: 'invalid_response' };
        const body = (await response.json()) as {
          choices?: Array<{ message?: { content?: unknown } }>;
        };
        const content = body.choices?.[0]?.message?.content;
        return typeof content === 'string'
          ? { ok: true, rawText: content }
          : { ok: false, error: 'invalid_response' };
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError')
          return { ok: false, error: 'timeout' };
        return { ok: false, error: 'network_error' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
