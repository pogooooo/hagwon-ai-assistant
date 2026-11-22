import { createHash } from 'node:crypto';
import { z } from 'zod';
import { tagById, tagCatalog } from '../academy-operations/classification.ts';
import {
  requireStaff,
  resolveBook,
  saveBookQuestion,
  workbookClasses,
} from '../academy-operations/workbook-catalog.ts';
import {
  field,
  transaction,
  type PageContext,
} from '../academy-operations/shared.ts';
import { GradingError, type AssignmentInput, type Item } from './contracts.ts';
import { gradingMediaLimits } from './media.ts';
import { newId, type GradingService } from './service.ts';

const workbookItems = z
  .array(
    z.object({
      page: z.number().int().min(1).max(100000),
      number: z.string().trim().min(1).max(80),
      tagIds: z.array(z.string()).max(25),
      version: z.number().int().positive().nullable().optional(),
      answer: z.string().trim().min(1).max(200),
      isChoice: z.boolean().optional(),
    }),
  )
  .min(1)
  .max(50);

const circled = '①②③④⑤⑥⑦⑧⑨';
const quantity =
  /^(-?\d+(?:\.\d+)?(?:\s*\/\s*\d+)?)\s*([A-Za-z%㎖㎗ℓ㎏㎝㎜㎞㎡가-힣]{0,4})$/u;

/**
 * 교사가 입력한 정답을 채점 정답으로 바꾼다. 보기 기호만 있으면 객관식, 수(와 단위) 하나면 수치,
 * 그 밖에는 글자 그대로 비교한다(| 로 나눈 허용 답안). AI 채점은 쓰지 않는다.
 */
export function keyFromAnswer(
  answer: string,
  isChoice?: boolean,
): {
  answer_type: Item['answer_type'];
  key: Pick<
    NonNullable<Item['key']>,
    | 'accepted_choice_sets'
    | 'accepted_texts'
    | 'numeric_target'
    | 'accepted_units'
    | 'normalization'
  >;
} {
  const options = answer
    .normalize('NFC')
    .split('|')
    .map((o) => o.trim())
    .filter(Boolean);
  if (!options.length) throw new GradingError('EMPTY_KEY');
  const exact = {
    unicode_form: 'NFC' as const,
    trim_outer_space: true,
    collapse_inner_space: true,
    case_sensitive: false,
  };
  const legacyChoice = options.every(
    (o) => /^[①-⑨]$/u.test(o) || /^[1-9]번$/u.test(o),
  );
  if (
    isChoice === true &&
    !answer.split('|').every((o) => /^[1-9]$/.test(o.trim()))
  )
    throw new GradingError('VALIDATION_FAILED');
  if (isChoice ?? legacyChoice)
    return {
      answer_type: 'choice_single',
      key: {
        accepted_choice_sets: options.map((o) => [
          String(circled.indexOf(o) + 1 || Number(o.replace('번', ''))),
        ]),
        accepted_texts: [],
        numeric_target: null,
        accepted_units: [],
        normalization: exact,
      },
    };
  const value = options.length === 1 && quantity.exec(options[0]);
  if (value)
    return {
      answer_type: 'numeric',
      key: {
        accepted_choice_sets: [],
        accepted_texts: [],
        numeric_target: value[1].replace(/\s/g, ''),
        accepted_units: value[2] ? [value[2]] : [],
        normalization: exact,
      },
    };
  return {
    answer_type: 'text_exact',
    key: {
      accepted_choice_sets: [],
      accepted_texts: options,
      numeric_target: null,
      accepted_units: [],
      normalization: exact,
    },
  };
}

/** 교재 문항(쪽·번호·대표 유형·정답) 하나를 정답 채점 문항으로 만든다. */
export function workbookItem(
  subject: 'M' | 'E',
  q: {
    page: number;
    number: string;
    tagIds: string[];
    answer: string;
    isChoice?: boolean;
  },
  photoPage: number,
  rights: string,
): Item {
  // 대표 유형: 교사가 처음 고른 유형. 유형이 없으면 과목 종합으로 집계한다.
  const tag = q.tagIds.length ? tagById.get(q.tagIds[0]) : undefined;
  const { answer_type, key } = keyFromAnswer(q.answer, q.isChoice);
  const itemRef = newId('item');
  return {
    item_ref: itemRef,
    item_no: q.number,
    book_page: q.page,
    subject_id: subject === 'M' ? 'MATH' : 'ENG',
    answer_type,
    primary_skill_id: tag ? tag.tagId : 'skill_unclassified_' + subject,
    skill_label: tag
      ? tag.area + ' · ' + tag.name
      : (subject === 'M' ? '수학' : '영어') + ' 유형 미지정',
    taxonomy_version: 'workbook-rubric-' + tagCatalog.rubricVersion,
    max_score: '1',
    expected_page_no: photoPage,
    rubric_id: newId('rubric'),
    rubric_version: '1',
    approval_status: 'approved',
    aggregation_rule: 'sum_criteria',
    criteria: [
      {
        criterion_id: newId('criterion'),
        label: '답안 내용',
        max_score: '1',
        allowed_scores: ['0', '1'],
        criterion_type: answer_type.startsWith('choice')
          ? 'choice'
          : answer_type === 'numeric'
            ? 'numeric'
            : 'exact_text',
        teacher_instruction: '교재 등록 때 입력한 정답과 비교해 채점합니다.',
      },
    ],
    key: {
      key_id: newId('key'),
      key_version: '1',
      source: 'teacher_registered',
      approval_status: 'approved',
      rights_ref: rights,
      absolute_tolerance: '0',
      relative_tolerance: '0',
      unit_conversion_allowed: false,
      required_form: null,
      ...key,
    },
  };
}

/**
 * 과제 등록 탭의 교재 과제를 저장한다. 고른 문항과 정답을 공용 교재 목록에 반영하고, 반마다 정답
 * 채점 과제를 하나씩 만든다. 사진 순서는 쪽수 오름차순이다(한 사진에 한 쪽).
 */
export function assignWorkbookGrading(
  ctx: PageContext,
  form: FormData,
  service: GradingService,
) {
  requireStaff(ctx);
  if (field(form, 'approved') !== 'yes')
    throw new GradingError('KEY_OR_RUBRIC_PENDING');
  const basis = field(form, 'rights_basis', 1000);
  if (!basis) throw new GradingError('VALIDATION_FAILED');
  const rights =
    'rights_' + createHash('sha256').update(basis).digest('hex').slice(0, 32);
  const title = field(form, 'title', 120);
  const requestKey = field(form, 'request_key', 100);
  let input: unknown;
  try {
    input = JSON.parse(field(form, 'items', 600000));
  } catch {
    throw new GradingError('VALIDATION_FAILED');
  }
  const parsed = workbookItems.safeParse(input);
  if (!parsed.success || !title || !requestKey)
    throw new GradingError('VALIDATION_FAILED');
  const classIds = [...new Set(form.getAll('classId').map(String))];
  if (!classIds.length) throw new GradingError('VALIDATION_FAILED');
  // 교재 목록 반영은 한 번에 저장하고, 반별 과제는 각자 멱등 키로 등록한다(등록이 자체 트랜잭션을 연다).
  const book = transaction(ctx.db, () => {
    const book = resolveBook(ctx, form);
    const allowed = workbookClasses(ctx).filter(
      (c) => c.subject === book.subject,
    );
    if (classIds.some((id) => !allowed.some((c) => c.id === id)))
      throw new GradingError('FORBIDDEN', 403);
    const seen = new Set<string>();
    for (const q of parsed.data) {
      const key = JSON.stringify([q.page, q.number]);
      if (seen.has(key)) throw new GradingError('VALIDATION_FAILED');
      seen.add(key);
      keyFromAnswer(q.answer, q.isChoice);
      saveBookQuestion(ctx, book, q);
    }
    return book;
  });
  const subject = book.subject === 'E' ? 'E' : 'M';
  const pages = [...new Set(parsed.data.map((q) => q.page))].sort(
    (a, b) => a - b,
  );
  if (pages.length > gradingMediaLimits().pages)
    throw new GradingError('PAGE_LIMIT');
  const ordered = [...parsed.data].sort(
    (a, b) =>
      a.page - b.page ||
      a.number.localeCompare(b.number, 'ko', { numeric: true }),
  );
  let first = '';
  for (const classId of classIds) {
    const definition: AssignmentInput = {
      title,
      class_id: classId,
      rights_ref: rights,
      items: ordered.map((q) =>
        workbookItem(subject, q, pages.indexOf(q.page) + 1, rights),
      ),
    };
    const created = service.register(
      ctx,
      definition,
      'wb_' +
        createHash('sha256')
          .update(requestKey + ':' + classId)
          .digest('hex')
          .slice(0, 40),
    );
    first ||= created.assignment_id;
  }
  return '/grading?assignment=' + encodeURIComponent(first);
}
