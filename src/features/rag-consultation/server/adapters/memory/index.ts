/**
 * 개발·테스트용 메모리 어댑터. 운영에서는 DB/세션 저장소 구현으로 교체한다.
 */
import type {
  Clock,
  ConversationStatePort,
  HandoffDraftInput,
  HandoffPort,
  RagLogEvent,
  RagLogger,
} from '../../ports.ts';
import type { ConversationState } from '../../types.ts';

export class InMemoryConversationStore implements ConversationStatePort {
  private readonly states = new Map<string, ConversationState>();

  private key(actorId: string, conversationId: string) {
    return `${actorId}\u0000${conversationId}`;
  }

  async load(
    actorId: string,
    conversationId: string,
  ): Promise<ConversationState | null> {
    const state = this.states.get(this.key(actorId, conversationId));
    return state ? structuredClone(state) : null;
  }

  async save(
    actorId: string,
    conversationId: string,
    state: ConversationState,
  ): Promise<void> {
    this.states.set(this.key(actorId, conversationId), structuredClone(state));
  }
}

export class InMemoryHandoffStore implements HandoffPort {
  readonly drafts: Array<HandoffDraftInput & { draftId: string }> = [];

  async createRequestOrDraft(
    input: HandoffDraftInput,
  ): Promise<{ draftId: string }> {
    const draftId = `handoff-${this.drafts.length + 1}`;
    this.drafts.push({ ...input, draftId });
    return { draftId };
  }
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

export class FixedClock implements Clock {
  private current: number;

  constructor(at: number) {
    this.current = at;
  }

  now(): number {
    return this.current;
  }

  set(at: number) {
    this.current = at;
  }
}

/** 질문·답변 원문 없이 최소 필드만 JSON 한 줄로 남긴다. */
export class ConsoleRagLogger implements RagLogger {
  log(event: RagLogEvent): void {
    console.info(JSON.stringify(event));
  }
}

export class MemoryRagLogger implements RagLogger {
  readonly events: RagLogEvent[] = [];

  log(event: RagLogEvent): void {
    this.events.push(event);
  }
}
