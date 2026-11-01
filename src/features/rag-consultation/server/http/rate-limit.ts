/** 사용자(actorId)별 단순 토큰 버킷. 다중 인스턴스 배포에서는 공유 저장소 구현으로 교체한다. */
export interface RateLimiter {
  consume(key: string, now: number): { allowed: boolean; retryAfterMs: number };
}

export class InMemoryTokenBucket implements RateLimiter {
  private readonly buckets = new Map<
    string,
    { tokens: number; updatedAt: number }
  >();
  private readonly capacity: number;
  private readonly refillPerMs: number;

  constructor(options: { capacity: number; refillPerMinute: number }) {
    this.capacity = options.capacity;
    this.refillPerMs = options.refillPerMinute / 60_000;
  }

  consume(key: string, now: number) {
    const bucket = this.buckets.get(key) ?? {
      tokens: this.capacity,
      updatedAt: now,
    };
    const tokens = Math.min(
      this.capacity,
      bucket.tokens + (now - bucket.updatedAt) * this.refillPerMs,
    );
    if (tokens < 1) {
      this.buckets.set(key, { tokens, updatedAt: now });
      return {
        allowed: false,
        retryAfterMs: Math.ceil((1 - tokens) / this.refillPerMs),
      };
    }
    this.buckets.set(key, { tokens: tokens - 1, updatedAt: now });
    return { allowed: true, retryAfterMs: 0 };
  }
}
