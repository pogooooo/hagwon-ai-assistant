import { createHash, randomUUID } from 'node:crypto';
import { GradingError, type AssignmentInput, type Item } from './contracts.ts';
export function photoItem(
  subject: Item['subject_id'],
  skill: string,
  page: number,
  label: string,
  itemRef = 'item_' + randomUUID().replaceAll('-', ''),
): Item {
  return {
    grading_mode: 'photo_solution',
    key: null,
    item_ref: itemRef,
    item_no: label,
    expected_page_no: page,
    subject_id: subject,
    answer_type: 'structured_work',
    max_score: '1',
    approval_status: 'approved',
    primary_skill_id:
      'skill_' +
      createHash('sha256')
        .update(subject + ':' + skill)
        .digest('hex')
        .slice(0, 20),
    skill_label: skill,
    taxonomy_version: 'academy-taxonomy-1',
    rubric_id: 'rubric_' + itemRef,
    rubric_version: 'photo-solution-1',
    aggregation_rule: 'sum_criteria',
    criteria: [
      {
        criterion_id: 'criterion_' + itemRef,
        label: '문항 점수',
        criterion_type: 'concept',
        max_score: '1',
        allowed_scores: ['0', '1'],
        teacher_instruction:
          '문제의 요구 조건과 독립 풀이를 기준으로 정오를 판단한다. 여러 답이 가능하면 타당한 동치 답안을 인정한다.',
      },
    ],
  };
}
export type PrintedPage = { printedPage: number | null; numbers: number[] };
export function itemsFromPhotos(
  scope: NonNullable<AssignmentInput['scope']>,
  pages: PrintedPage[],
): Item[] {
  const seenPages = new Set<number>();
  let total = 0;
  return pages.flatMap((page, index) => {
    if (
      !page.numbers.length ||
      new Set(page.numbers).size !== page.numbers.length ||
      (total += page.numbers.length) > 50 ||
      page.numbers.some((n) => !Number.isInteger(n) || n < 1 || n > 999)
    )
      throw new GradingError('PHOTO_SCOPE_UNCLEAR');
    const printed = page.printedPage;
    if (scope.kind === 'workbook') {
      if (
        printed === null ||
        !Number.isSafeInteger(printed) ||
        printed < scope.from ||
        printed > scope.to ||
        seenPages.has(printed)
      )
        throw new GradingError('PHOTO_SCOPE_UNCLEAR');
      seenPages.add(printed);
    }
    return page.numbers.map((n) =>
      photoItem(scope.subject, scope.skill, index + 1, String(n)),
    );
  });
}
