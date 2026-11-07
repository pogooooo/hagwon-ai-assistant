import { compactText } from '../text/normalize.ts';
import type { RagAccessScope } from '../types.ts';
import type { QueryFrame } from './parse-query.ts';

export function refersToPriorUnit(text: string): boolean {
  return /^(?:그|아까\s*말한|방금\s*말한)\s*(?:단원|영역|유형)(?:의|은|는|이|가|을|를)?(?![가-힣])/.test(
    text,
  );
}

/** Recognizes an explicit authorized learner followed by a short continuation. */
export function isStudentOnlyFollowUp(
  { frame, access }: { frame: QueryFrame; access: RagAccessScope },
  allowSubject = false,
): boolean {
  const [studentId] = frame.matchedStudentIds;
  if (
    frame.matchedStudentIds.length !== 1 ||
    !access.allowedStudentIds.includes(studentId)
  )
    return false;
  const [lead, ...rest] = frame.normalized.split(/[?？]/).filter(Boolean);
  const suffix = /(?:은|는)요\s*$/;
  if (!lead || !suffix.test(lead)) return false;
  const tail = compactText(rest.join(' '));
  if (
    tail &&
    (!allowSubject ||
      frame.subjects.length !== 1 ||
      tail !== compactText(frame.subjects[0]) + '만요')
  )
    return false;
  const target = compactText(lead.replace(suffix, ''));
  const student = access.studentRefs.find((ref) => ref.studentId === studentId);
  return (
    !!student &&
    [student.displayLabel, ...student.aliases].some(
      (label) => compactText(label) === target,
    )
  );
}
