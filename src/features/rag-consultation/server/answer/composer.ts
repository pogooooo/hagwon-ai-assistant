import type { AnswerDraft } from './context.ts';

/** 부분 답변 합치기: 거부가 하나라도 있으면 거부(fail-closed), 확인 질문이 있으면 확인 질문, 일부만 답하면 일부 답변. */
export function composeRequests(
  drafts: AnswerDraft[],
  parts: string[],
): AnswerDraft {
  const denied = drafts.find((d) => d.status === 'denied');
  if (denied) return denied;
  const clarify = drafts.find((d) => d.status === 'clarify');
  if (clarify) return clarify;
  const gave = drafts.filter(
    (d) => d.status === 'answered' || d.status === 'partial',
  );
  if (gave.length === 0)
    return drafts.find((d) => d.status === 'handoff') ?? drafts[0];
  const missing = drafts.flatMap((d, i) =>
    d.status === 'answered'
      ? []
      : d.status === 'partial'
        ? (d.missingFields ?? [])
        : d.missingFields?.length
          ? d.missingFields
          : [parts[i].replace(/[?？]$/, '')],
  );
  const lines = [...new Set(gave.flatMap((d) => d.text.split('\n')))];
  if (
    missing.length > 0 &&
    !gave.some((d) => d.text.includes('확인되지 않은 항목'))
  )
    lines.push(`확인되지 않은 항목: ${missing.join(', ')}.`);
  return {
    status: missing.length > 0 ? 'partial' : 'answered',
    text: lines.join('\n'),
    citations: gave.flatMap((d) => d.citations),
    usedFacts: gave.flatMap((d) => d.usedFacts),
    excerpts: gave.flatMap((d) => d.excerpts ?? []),
    missingFields: missing.length > 0 ? missing : undefined,
    reasonCode: missing.length > 0 ? 'PARTIAL_EVIDENCE' : undefined,
    derivedNumbers: gave.flatMap((d) => d.derivedNumbers ?? []),
    instants: gave.flatMap((d) => d.instants ?? []),
    generated: gave.some((d) => d.generated),
    internalErrors: drafts.flatMap((d) => d.internalErrors ?? []),
    conversationUpdate: gave.at(-1)?.conversationUpdate,
  };
}
