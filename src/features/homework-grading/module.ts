import { renderStudentReports } from '../academy-operations/student-reports.ts';
import { renderReportDocument } from '../academy-operations/report-document.ts';
import { photoItem } from './assigned-work.ts';
import { gradingOverview, gradingStates as names } from './overview.ts';
import { createHash } from 'node:crypto';
import { accessibleClasses } from '../academy-operations/directory.ts';
import {
  escapeHtml as h,
  field,
  one,
  OperationError,
  rows,
  type OperationModule,
  type PageContext,
} from '../academy-operations/shared.ts';
import {
  GradingError,
  outcomeNames,
  subjectNames,
  subjects,
  kstDate,
  type DraftItem,
  type Item,
  type RetainedItem,
} from './contracts.ts';
import { decimalString, points } from './arithmetic.ts';
import { aggregate, emptyResult, propose } from './scoring.ts';
import { createNaverGrader } from './provider.ts';
import {
  submissionAssignment,
  listAssignments,
  GradingService,
  demoPhotoPolicy,
  personalPhotoPolicy,
  gradingProviderErrors,
  newId,
  readSubmission,
  setupGrading,
} from './service.ts';
import {
  approveReport,
  generateReport,
  readReport,
  readSnapshot,
  snapshot,
} from './facts.ts';
import { cropAnswer, gradingMediaLimits } from './media.ts';
import type { OperationsDatabase } from '../academy-operations/database.ts';

const services = new WeakMap<OperationsDatabase, GradingService>();
export function gradingService(
  db: OperationsDatabase,
  env: Record<string, string | undefined> = process.env,
) {
  let service = services.get(db);
  if (!service) {
    const policy = env.AXR_GRADING_DEMO_PRACTICE_POLICY;
    const practicePolicy =
      policy === demoPhotoPolicy || policy === personalPhotoPolicy
        ? policy
        : undefined;
    service = new GradingService(db, {
      provider: createNaverGrader(env, db),
      practicePolicy,
      practiceProvider: practicePolicy
        ? createNaverGrader(
            {
              ...env,
              CLOVA_STUDIO_API_KEY:
                env.AXR_GRADING_PRACTICE_API_KEY || env.CLOVA_STUDIO_API_KEY,
              AXR_GRADING_EXTERNAL_DATA_APPROVED: 'true',
              AXR_GRADING_INPUT_POLICY_REF: practicePolicy,
            },
            db,
          )
        : undefined,
      rawTtlMs: Number(env.AXR_GRADING_RAW_TTL_MS ?? 3600000),
      inputPolicyRef: env.AXR_GRADING_INPUT_POLICY_REF,
      restoredBackup: env.AXR_GRADING_RESTORED_BACKUP === 'true',
    });
    services.set(db, service);
  }
  return service;
}
/** Explicit dependency injection for offline integration tests and hosted runtimes. */
export function configureGrading(
  db: OperationsDatabase,
  service: GradingService,
) {
  services.set(db, service);
}
const errorNames: Record<string, string> = {
  VALIDATION_FAILED: '입력값을 확인해 주세요.',
  PRACTICE_SCOPE: '이 계정과 과제에서는 체험용 사진 전송을 사용할 수 없습니다.',
  PHOTO_CONSENT_REQUIRED:
    '이름·학교·얼굴을 가린 답안인지 확인하고 네이버 CLOVA 사진 전송에 동의해 주세요.',
  INVALID_SCORE: '점수와 배점을 확인해 주세요.',
  INVALID_RUBRIC: '요소별 배점·허용 점수와 문항 만점을 확인해 주세요.',
  EMPTY_KEY: '채점할 정답을 등록해 주세요.',
  REVIEW_REFERENCE_REQUIRED:
    'AI 풀이가 없으면 원본에서 확인한 정답을 입력하거나 판독·채점 불가로 남겨 주세요.',
  INVALID_PHOTO_RANGE:
    '쪽마다 문항 번호를 입력해 주세요. 중복 없이 1~50문항까지 등록할 수 있습니다.',
  KEY_OR_RUBRIC_PENDING: '정답과 채점 기준을 승인한 후 점수를 확정해 주세요.',
  TEACHER_REVIEW_REQUIRED: '모든 문항의 확인 항목을 체크해 주세요.',
  REVIEW_UNRESOLVED:
    '판독과 문항 연결을 확인하거나 판독·채점 불가로 남겨 주세요.',
  REVISION_MISMATCH:
    '다른 작업으로 내용이 바뀌었습니다. 새로고침 후 확인해 주세요.',
  STATE_CONFLICT: '처리 상태가 바뀌었습니다. 새로고침해 주세요.',
  SNAPSHOT_STALE:
    '성적이 변경되었습니다. 최신 기록으로 리포트를 다시 생성해 주세요.',
  RAW_EXPIRED: '사진 보존기한이 끝났습니다. 필요한 경우 다시 제출해 주세요.',
  RAW_CLOSED:
    '사진 검수가 종료되었습니다. 새 사진은 정정 증거로 제출해 주세요.',
  PURGE_NOT_VERIFIED: '원문 삭제 또는 성적 정정이 완료되면 공개됩니다.',
  RESOURCE_NOT_FOUND: '자료를 찾을 수 없습니다.',
  FORBIDDEN: '이 자료에 접근할 권한이 없습니다.',
  INPUT_UNREADABLE:
    '사진이나 PDF를 읽을 수 없습니다. 파일 손상·크기·기울기를 확인해 주세요.',
  UNSUPPORTED_MEDIA: 'JPG·PNG·WEBP 사진 또는 PDF를 올려 주세요.',
  MEDIA_BUSY: '다른 답안 사진을 처리하고 있습니다. 잠시 후 다시 시도해 주세요.',
  PAGE_LIMIT: '허용된 제출 쪽수를 초과했습니다.',
  UPLOAD_LIMIT: '업로드 크기나 파일 개수 제한을 초과했습니다.',
  PAGE_COUNT_MISMATCH: '과제 문항의 쪽수와 제출 페이지 수를 확인해 주세요.',
  CORRECTION_REQUIRES_REVISION:
    '정정 증거는 기존 성적의 정정 화면에서 확정해 주세요.',
  EVIDENCE_REFERENCE_MISMATCH:
    '기존 성적과 정정 증거의 학생·과제·버전을 확인해 주세요.',
};
export function gradingError(error: unknown): never {
  if (error instanceof GradingError)
    throw new OperationError(
      errorNames[error.code] ??
        '입력 또는 처리 상태를 확인해 주세요. (' + error.code + ')',
      error.status,
    );
  throw error;
}
const input = (
  name: string,
  label: string,
  value = '',
  type = 'text',
  extra = '',
) =>
  `<label>${h(label)}<input name="${h(name)}" type="${type}" value="${h(value)}" ${extra}></label>`;
const choice = (
  name: string,
  label: string,
  values: readonly string[],
  selected: string,
  labels?: Record<string, string>,
) =>
  `<label>${h(label)}<select name="${h(name)}">${values.map((v) => `<option value="${h(v)}"${v === selected ? ' selected' : ''}>${h(labels?.[v] ?? v)}</option>`).join('')}</select></label>`;
const hidden = (name: string, value: unknown) =>
  `<input type="hidden" name="${h(name)}" value="${h(value)}">`;
const startForm = (action: string) =>
  `<form method="post" action="/grading">${hidden('action', action)}${hidden('request_key', newId('request'))}`;
function number(form: FormData, key: string, min = 0, max = 10000) {
  const value = Number(field(form, key));
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new GradingError('VALIDATION_FAILED');
  return value;
}
function photoItems(form: FormData): Item[] {
  const subject = field(form, 'subject') as Item['subject_id'];
  const skill = field(form, 'skill', 120) || subjectNames[subject] + ' 종합';
  const pages = field(form, 'question_pages', 1000).split(/\r?\n/);
  const items: Item[] = [];
  const seen = new Set<string>();
  if (pages.length > gradingMediaLimits().pages)
    throw new GradingError('PAGE_LIMIT');
  for (const [page, line] of pages.entries()) {
    for (const token of line.trim().split(/[,\s]+/)) {
      const match = /^(\d{1,3})(?:[-~](\d{1,3}))?$/.exec(token);
      if (!match) throw new GradingError('INVALID_PHOTO_RANGE');
      const start = Number(match[1]),
        end = Number(match[2] || start);
      if (!start || end < start || items.length + end - start + 1 > 50)
        throw new GradingError('INVALID_PHOTO_RANGE');
      for (let n = start; n <= end; n++) {
        if (seen.has(String(n))) throw new GradingError('INVALID_PHOTO_RANGE');
        seen.add(String(n));
        items.push(photoItem(subject, skill, page + 1, String(n)));
      }
    }
  }
  return items;
}
function registration(form: FormData) {
  if (field(form, 'approved') !== 'yes')
    throw new GradingError('KEY_OR_RUBRIC_PENDING');
  const rights =
    'rights_' +
    createHash('sha256')
      .update(field(form, 'rights_basis', 1000))
      .digest('hex')
      .slice(0, 32);
  if (!field(form, 'rights_basis')) throw new GradingError('VALIDATION_FAILED');
  const kind = field(form, 'material');
  if (kind) {
    if (kind !== 'workbook' && kind !== 'worksheet')
      throw new GradingError('VALIDATION_FAILED');
    const subject = field(form, 'subject') as Item['subject_id'];
    const name = field(form, 'material_name', 140);
    if (!name) throw new GradingError('VALIDATION_FAILED');
    const skill = field(form, 'skill', 120) || subjectNames[subject] + ' 종합';
    const scope =
      kind === 'workbook'
        ? {
            kind,
            subject,
            skill,
            from: number(form, 'page_from', 1, 9999),
            to: number(form, 'page_to', 1, 9999),
          }
        : { kind, subject, skill };
    return {
      title:
        scope.kind === 'workbook'
          ? name + ' · ' + scope.from + '–' + scope.to + '쪽'
          : name,
      class_id: field(form, 'class_id'),
      rights_ref: rights,
      scope,
      items: [],
    };
  }
  if (field(form, 'mode') === 'photo_solution')
    return {
      title: field(form, 'title'),
      class_id: field(form, 'class_id'),
      rights_ref: rights,
      items: photoItems(form),
    };
  const count = number(form, 'count', 1, 50);
  const items = Array.from({ length: count }, (_, n): Item => {
    const prefix = 'q' + n + '_',
      subject = field(form, prefix + 'subject') as Item['subject_id'],
      answerType = field(form, prefix + 'type') as Item['answer_type'];
    const max = field(form, prefix + 'max'),
      keyText = field(form, prefix + 'key', 12000),
      skill = field(form, prefix + 'skill');
    const formRule = field(form, prefix + 'form') || null,
      formPoints = formRule ? field(form, prefix + 'form_points') || '0' : '0';
    const itemRef = newId('item'),
      skillId =
        'skill_' +
        createHash('sha256')
          .update(subject + ':' + skill)
          .digest('hex')
          .slice(0, 20);
    if (points(formPoints) >= points(max))
      throw new GradingError('INVALID_RUBRIC');
    const coreMax = decimalString(points(max) - points(formPoints));
    const allowed = field(form, prefix + 'scores')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const core = {
      criterion_id: newId('criterion'),
      label: '답안 내용',
      max_score: coreMax,
      allowed_scores: allowed.length && !formRule ? allowed : ['0', coreMax],
      criterion_type: answerType.startsWith('choice')
        ? ('choice' as const)
        : answerType === 'numeric'
          ? ('numeric' as const)
          : answerType === 'text_exact'
            ? ('exact_text' as const)
            : ('concept' as const),
      teacher_instruction:
        field(form, prefix + 'rubric', 3000) ||
        '등록한 정답과 문항에서 요구한 조건에 따라 점수를 부여합니다.',
    };
    return {
      item_ref: itemRef,
      item_no: field(form, prefix + 'no'),
      subject_id: subject,
      answer_type: answerType,
      primary_skill_id: skillId,
      skill_label: skill,
      taxonomy_version: 'academy-taxonomy-1',
      max_score: max,
      expected_page_no: number(form, prefix + 'page', 1, 10),
      rubric_id: newId('rubric'),
      rubric_version: '1',
      approval_status: 'approved',
      aggregation_rule: 'sum_criteria',
      criteria: [
        core,
        ...(points(formPoints)
          ? [
              {
                criterion_id: newId('criterion'),
                label: '요구한 답안 형식',
                max_score: formPoints,
                allowed_scores: ['0', formPoints],
                criterion_type: 'format' as const,
                teacher_instruction:
                  '값의 정답 여부와 별도로 요구한 답안 형식을 평가합니다.',
              },
            ]
          : []),
      ],
      key: keyText
        ? {
            key_id: newId('key'),
            key_version: '1',
            source: 'teacher_registered',
            approval_status: 'approved',
            rights_ref: rights,
            accepted_choice_sets: answerType.startsWith('choice')
              ? keyText.split('|').map((v) =>
                  v
                    .split(',')
                    .map((x) => x.trim())
                    .filter(Boolean),
                )
              : [],
            accepted_texts:
              answerType.startsWith('text') || answerType === 'symbolic'
                ? keyText
                    .split('|')
                    .map((s) => s.trim())
                    .filter(Boolean)
                : [],
            numeric_target: answerType === 'numeric' ? keyText : null,
            absolute_tolerance: field(form, prefix + 'tolerance') || '0',
            relative_tolerance: '0',
            accepted_units: field(form, prefix + 'units')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
            unit_conversion_allowed: field(form, prefix + 'convert') === 'yes',
            required_form: formRule as NonNullable<
              Item['key']
            >['required_form'],
            normalization: {
              unicode_form: 'NFC',
              trim_outer_space: true,
              collapse_inner_space: field(form, prefix + 'space') === 'yes',
              case_sensitive: field(form, prefix + 'case') !== 'no',
            },
          }
        : null,
    };
  });
  return {
    title: field(form, 'title'),
    class_id: field(form, 'class_id'),
    rights_ref: rights,
    items,
  };
}
async function submit(ctx: PageContext, form: FormData) {
  const service = gradingService(ctx.db);
  const action = field(form, 'action');
  try {
    await service.sweep();
    if (action === 'register') {
      const assignment = service.register(
        ctx,
        registration(form),
        field(form, 'request_key'),
      );
      return (
        '/grading?assignment=' + encodeURIComponent(assignment.assignment_id)
      );
    }
    if (action === 'map_pages') {
      const s = readSubmission(ctx, field(form, 'submission'), true);
      const a = submissionAssignment(ctx.db, s);
      if (!a.scope) throw new GradingError('VALIDATION_FAILED');
      const pages = Array.from({ length: s.expected_pages }, (_, i) => {
        const nums = field(form, 'numbers_' + i, 500);
        if (!/^\d{1,3}(?:[ ,]+\d{1,3})*$/.test(nums))
          throw new GradingError('INVALID_PHOTO_RANGE');
        return {
          printedPage:
            a.scope!.kind === 'workbook'
              ? number(form, 'printed_' + i, 1, 9999)
              : null,
          numbers: nums.split(/[ ,]+/).map(Number),
        };
      });
      await service.correctPhotoMap(
        ctx,
        s.id,
        number(form, 'revision', 1),
        pages,
      );
      return '/grading?submission=' + encodeURIComponent(s.id);
    }
    if (action === 'upload') {
      const assignmentId = field(form, 'assignment');
      const selected = listAssignments(ctx).find(
        (a) => a.assignment_id === assignmentId,
      );
      if (!selected) throw new GradingError('RESOURCE_NOT_FOUND', 404);
      const autoPages = !form.has('pages');
      const files: { bytes: Uint8Array; mime: string }[] = [];
      for (const file of form.getAll('photos'))
        if (typeof file !== 'string' && file.size)
          files.push({
            bytes: new Uint8Array(await file.arrayBuffer()),
            mime: file.type,
          });
      const submission = service.create(
        ctx,
        {
          assignment_id: assignmentId,
          assignment_version: 1,
          student_ref: field(form, 'student'),
          ...(field(form, 'practice') === 'yes'
            ? { practice_consent: true }
            : {}),
          expected_page_count: autoPages
            ? Math.max(1, ...selected.items.map((i) => i.expected_page_no))
            : number(form, 'pages', 1, gradingMediaLimits().pages),
          ...(field(form, 'target')
            ? {
                submission_purpose: 'correction_evidence' as const,
                target_result_set_id: field(form, 'target'),
                target_result_revision: number(form, 'target_revision', 1),
              }
            : {}),
        },
        field(form, 'request_key'),
      );
      try {
        await service.upload(
          ctx,
          submission.submission_id,
          files,
          ctx.maxDocumentBytes,
          autoPages,
        );
        await service.process(ctx, submission.submission_id);
      } finally {
        for (const file of files) file.bytes.fill(0);
      }
      return (
        '/grading?submission=' + encodeURIComponent(submission.submission_id)
      );
    }
    if (action === 'review') {
      const id = field(form, 'submission'),
        draft = await service.draft(ctx, id),
        s = readSubmission(ctx, id, true),
        a = submissionAssignment(ctx.db, s);
      const items: DraftItem[] = draft.items.map((old, n) => {
        const def = a.items.find(
            (i) => i.item_ref === old.extraction.item_ref,
          )!,
          prefix = 'r' + n + '_';
        const status = field(
          form,
          prefix + 'answer_status',
        ) as typeof old.extraction.answer_status;
        const located = field(form, prefix + 'located') === 'yes';
        const extraction = {
          ...old.extraction,
          answer_observed: field(form, prefix + 'answer', 12000),
          unit_observed: field(form, prefix + 'unit'),
          answer_status: status,
          association_status: located
            ? ('matched' as const)
            : ('ambiguous' as const),
          ambiguity_codes:
            located && ['readable', 'blank'].includes(status)
              ? []
              : old.extraction.ambiguity_codes,
          regions:
            located && !old.extraction.regions.length
              ? [
                  {
                    page_no: def.expected_page_no,
                    bbox: [0, 0, 1, 1] as [number, number, number, number],
                  },
                ]
              : old.extraction.regions,
        };
        const outcome = field(
          form,
          prefix + 'outcome',
        ) as RetainedItem['outcome'];
        let proposed: RetainedItem;
        if (outcome === 'ungradable' || outcome === 'excluded')
          proposed = emptyResult(
            def,
            outcome === 'excluded'
              ? 'TEACHER_EXCLUDED'
              : def.grading_mode === 'photo_solution'
                ? (old.proposed.exclusion_reason ?? 'UNSUPPORTED')
                : def.key
                  ? 'UNREADABLE'
                  : 'NO_KEY',
          );
        else {
          proposed = aggregate(
            def,
            def.criteria.map((c, i) => ({
              criterion_id: c.criterion_id,
              max_score: c.max_score,
              score: field(form, prefix + 'score_' + i),
            })),
          );
          if (outcome === 'blank' && proposed.score === '0')
            proposed = { ...proposed, outcome: 'blank' };
          if (outcome !== proposed.outcome)
            throw new GradingError('INVALID_SCORE');
        }
        return {
          extraction,
          proposed,
          review_reference:
            def.grading_mode === 'photo_solution'
              ? field(form, prefix + 'reference', 1200)
              : undefined,
          reviewed: field(form, prefix + 'reviewed') === 'yes',
        };
      });
      await service.patch(ctx, id, number(form, 'revision', 1), items);
      return '/grading?submission=' + encodeURIComponent(id);
    }
    if (action === 'confirm') {
      const id = field(form, 'submission');
      if (field(form, 'review_complete') !== 'yes')
        throw new GradingError('TEACHER_REVIEW_REQUIRED');
      const s = readSubmission(ctx, id, true);
      if (s.purpose === 'correction_evidence') {
        await service.revise(
          ctx,
          s.target!,
          {
            expected_result_revision: s.target_revision!,
            reason_code: 'SCORE_CORRECTION',
            new_submission_id: id,
            expected_evidence_draft_revision: number(form, 'revision', 1),
            expected_evidence_raw_generation: s.generation,
          },
          field(form, 'request_key'),
        );
      } else
        await service.confirm(
          ctx,
          id,
          number(form, 'revision', 1),
          field(form, 'request_key'),
        );
      await service.purge(id);
      return (
        '/grading?submission=' +
        encodeURIComponent(
          s.purpose === 'assessment'
            ? id
            : one<{ id: string }>(
                ctx.db,
                'SELECT id FROM grading_v3_submissions WHERE tenant=? AND result_id=?',
                s.tenant,
                s.target!,
              )!.id,
        )
      );
    }
    if (action === 'cancel') {
      await service.cancel(ctx, field(form, 'submission'));
      return '/grading';
    }
    if (action === 'purge') {
      const s = readSubmission(ctx, field(form, 'submission'), true);
      await service.purge(s.id);
      return '/grading?submission=' + encodeURIComponent(s.id);
    }
    if (action === 'date') {
      await service.revise(
        ctx,
        field(form, 'result'),
        {
          expected_result_revision: number(form, 'revision', 1),
          reason_code: 'DATE_CORRECTION',
          assessment_date: field(form, 'date'),
        },
        field(form, 'request_key'),
      );
      return '/grading';
    }
    if (action === 'report') {
      const s = snapshot(
        ctx,
        {
          student_ref: field(form, 'student'),
          from_date: field(form, 'from'),
          to_date_exclusive: field(form, 'to'),
          comparison_period:
            field(form, 'compare_from') || field(form, 'compare_to')
              ? {
                  from_date: field(form, 'compare_from'),
                  to_date_exclusive: field(form, 'compare_to'),
                }
              : null,
          subjects: form.getAll('subject').map(String),
          attempt_policy: field(form, 'attempt'),
          statistics_policy_version: 'grading-stats-3.0',
        },
        service.now(),
      );
      const report = await generateReport(ctx, service, s.snapshot_id);
      return '/grading?report=' + encodeURIComponent(report.report_id);
    }
    if (action === 'approve_report') {
      if (field(form, 'review_complete') !== 'yes')
        throw new GradingError('TEACHER_REVIEW_REQUIRED');
      const id = field(form, 'report');
      approveReport(
        ctx,
        id,
        number(form, 'revision', 1),
        number(form, 'generation'),
        field(form, 'hash'),
      );
      return '/grading?report=' + encodeURIComponent(id);
    }
    throw new GradingError('VALIDATION_FAILED');
  } catch (error) {
    gradingError(error);
  }
}
function gradingAvailability(
  service: GradingService,
  practiceAvailable: boolean,
) {
  if (service.provider.inputAllowed)
    return '<p>제출한 답안은 네이버 CLOVA로 채점하고 선생님이 결과를 확인합니다.</p>';
  if (practiceAvailable)
    return '<p>네이버 CLOVA 사진 채점 사용 가능 · 체험 학원에는 이름·학교·얼굴을 가린 연습 답안을 제출해 주세요.</p>';
  return '<p>이 과제는 선생님이 직접 확인합니다. 이 계정에서는 사진을 네이버로 전송할 수 없습니다.</p>';
}
function photoRegisterForm(ctx: PageContext) {
  const classes = accessibleClasses(ctx.db, ctx.actor);
  const worksheet = ctx.url.searchParams.get('material') === 'worksheet';
  const kind = worksheet ? 'worksheet' : 'workbook';
  return `<h2>AI 풀이로 채점할 과제</h2><nav class="grade-filters" aria-label="과제 종류"><a href="/grading?view=register&amp;material=workbook"${worksheet ? '' : ' aria-current="page"'}>문제집 범위</a><a href="/grading?view=register&amp;material=worksheet"${worksheet ? ' aria-current="page"' : ''}>나눠 준 문제지</a></nav>${startForm('register')}${hidden('mode', 'photo_solution')}${hidden('material', kind)}${input('material_name', worksheet ? '나눠 준 문제지 이름' : '문제집 이름', '', 'text', 'required maxlength="140"')}${worksheet ? '' : '<div class="form-grid">' + input('page_from', '시작 쪽', '', 'number', 'min="1" max="9999" required') + input('page_to', '마지막 쪽', '', 'number', 'min="1" max="9999" required') + '</div>'}${choice(
    'class_id',
    '배정 반',
    classes.map((c) => c.id),
    '',
    Object.fromEntries(classes.map((c) => [c.id, c.name])),
  )}${choice('subject', '과목', subjects, 'MATH', subjectNames)}<p>정답과 문항 번호는 입력할 필요가 없습니다. 학생이 푼 사진에서 문항과 답을 읽습니다.${worksheet ? '' : ' 책 쪽수가 사진에 보이게 제출해 주세요.'}</p>${input('skill', '학습 유형 (선택)', '', 'text', 'maxlength="120"')}<label>자료 이용 근거<select name="rights_basis" required><option value="">선택해 주세요</option><option>직접 만든 자료</option><option>사진 채점 이용을 허락받은 자료</option><option>해당 이용이 허용된 공개 자료</option></select></label><label><input type="checkbox" name="approved" value="yes" required>자료 이용 근거와 배정 범위를 확인했습니다.</label><button>과제 등록</button></form>`;
}
function registerForm(ctx: PageContext) {
  const count = Math.max(
    1,
    Math.min(50, Number(ctx.url.searchParams.get('count')) || 3),
  );
  const types = [
    'choice_single',
    'choice_multiple',
    'text_exact',
    'numeric',
    'symbolic',
    'text_semantic',
    'structured_work',
    'essay',
  ];
  const labels = {
    choice_single: '객관식 단일 선택',
    choice_multiple: '객관식 복수 선택',
    text_exact: '등록 답안 단답',
    numeric: '숫자·분수',
    symbolic: '등록된 수식 답안',
    text_semantic: '짧은 의미 답안',
    structured_work: '풀이 과정 검수 보조',
    essay: '서술·영작 검수 보조',
  };
  return (
    photoRegisterForm(ctx) +
    `<details${ctx.url.searchParams.has('count') ? ' open' : ''}><summary>정답·배점을 직접 지정하는 과제</summary><form method="get" action="/grading" class="inline-form">${hidden('view', 'register')}${input('count', '등록할 문항 수', String(count), 'number', 'min="1" max="50"')}<button class="secondary">입력 칸 만들기</button></form>${startForm('register')}${hidden('count', count)}${input('title', '과제 이름', '', 'text', 'required maxlength="200"')}${choice(
      'class_id',
      '배정 반',
      accessibleClasses(ctx.db, ctx.actor).map((c) => c.id),
      '',
      Object.fromEntries(
        accessibleClasses(ctx.db, ctx.actor).map((c) => [c.id, c.name]),
      ),
    )}${input('rights_basis', '자료 이용 근거 — 자체 제작 또는 이용허락 기록', '', 'text', 'required maxlength="500"')}
    ${Array.from({ length: count }, (_, n) => {
      const p = 'q' + n + '_';
      return `<fieldset><legend>${n + 1}번째 문항</legend><div class="form-grid">${input(p + 'no', '문항 번호', String(n + 1), 'text', 'required')}${input(p + 'page', '사진/PDF 쪽수', '1', 'number', 'min="1" max="10" required')}${choice(p + 'subject', '과목', subjects, subjects[n % 3], subjectNames)}${choice(p + 'type', '답안 종류', types, 'text_exact', labels)}${input(p + 'skill', '대표 유형', '', 'text', 'required maxlength="120"')}${input(p + 'max', '문항 배점', '1', 'text', 'required inputmode="decimal"')}${input(p + 'key', '정답 — 허용 답안은 | 로, 복수 선택은 쉼표로 구분', '', 'text', 'maxlength="12000"')}${input(p + 'units', '허용 단위 — 없으면 비워두기')}${input(p + 'tolerance', '숫자 허용 오차', '0', 'text', 'inputmode="decimal"')}${input(p + 'scores', '부분점수를 허용할 점수 목록 — 예: 0,1,2')}${choice(p + 'form', '수학 답안 형식', ['', 'integer', 'decimal', 'fraction', 'reduced_fraction'], '', { '': '제한 없음', integer: '정수', decimal: '소수', fraction: '분수', reduced_fraction: '기약분수' })}${input(p + 'form_points', '형식 평가 배점 — 내용 배점과 분리할 때', '0', 'text', 'inputmode="decimal"')}</div><label>채점 기준<textarea name="${p}rubric" maxlength="3000" placeholder="의미 답안·서술형은 필수 내용, 부정·인과 관계, 허용 점수를 구체적으로 적어 주세요."></textarea></label><label><input type="checkbox" name="${p}space" value="yes">내부 연속 공백 차이 허용</label><label><input type="checkbox" name="${p}case" value="no">영어 대소문자 차이 허용</label><label><input type="checkbox" name="${p}convert" value="yes">등록한 첫 단위를 기준으로 지원되는 단위 환산 허용</label></fieldset>`;
    }).join(
      '',
    )}<label><input type="checkbox" name="approved" value="yes" required>자료 이용 근거와 정답·배점·채점 기준을 확인하고 승인합니다.</label><button>과제 등록</button></form></details>`
  );
}
async function render(ctx: PageContext) {
  const service = gradingService(ctx.db),
    staff = ['admin', 'teacher'].includes(ctx.actor.role);
  try {
    await service.sweep();
    const overview = gradingOverview(ctx);
    const { assignments, students } = overview;
    const requestedView = ctx.url.searchParams.get('view');
    let detail = '';
    const id = ctx.url.searchParams.get('submission');
    if (id && requestedView !== 'upload') {
      const s = readSubmission(ctx, id);
      const a = submissionAssignment(ctx.db, s);
      detail = `<section class="panel"><h2>${h(a.title)}</h2><p>${h(names[s.processing])} · ${h(names[s.raw_state])}</p>${a.scope?.kind === 'workbook' && a.photoPages.length ? '<p>이번 제출의 책 쪽수 · ' + a.photoPages.map((p) => h(p.printedPage)).join(', ') + '쪽</p>' : ''}`;
      if (
        s.result_id &&
        s.current_revision === s.published_revision &&
        s.published_revision
      ) {
        const result = service.result(ctx, s.result_id);
        const linked = service.linkedReport(ctx, result);
        if (linked)
          detail +=
            '<a class="grade-report-row" href="/grading?report=' +
            encodeURIComponent(linked) +
            '"><strong>이 과제의 분석 리포트</strong><span>열기 ›</span></a>';
        else if (staff) detail += '<p>리포트 초안을 준비하고 있습니다.</p>';
        detail += `<p>확정 ${result.revision}차 · 수행일 ${h(result.assessment_date)} · 원문은 삭제되었습니다.</p><div class="table-wrap"><table><thead><tr><th>문항</th><th>과목·유형</th><th>결과</th><th>점수</th></tr></thead><tbody>${result.items.map((i) => `<tr><td>${h(a.items.find((d) => d.item_ref === i.item_ref)?.item_no)}</td><td>${subjectNames[i.subject_id]} · ${h(a.items.find((d) => d.item_ref === i.item_ref)?.skill_label)}</td><td>${outcomeNames[i.outcome]}</td><td>${h(i.score ?? '집계 제외')} / ${h(i.max_score)}</td></tr>`).join('')}</tbody></table></div>`;
        if (staff)
          detail += `<details><summary>수행일 정정</summary>${startForm('date')}${hidden('result', s.result_id)}${hidden('revision', result.revision)}${input('date', '확인한 수행일', result.assessment_date, 'date', 'required')}<button>새 정정 이력으로 저장</button></form></details><p>점수 정정이 필요하면 <a href="/grading?view=upload&amp;submission=${encodeURIComponent(s.id)}">같은 답안의 정정 사진 제출</a>을 이용해 주세요. 다시 푼 숙제는 새 풀이로 제출합니다.</p>`;
      } else if (
        staff &&
        ['REVIEW_REQUIRED', 'READY_TO_CONFIRM'].includes(s.processing)
      ) {
        const draft = await service.draft(ctx, s.id);
        detail = '<section class="panel grading-workspace">';
        if (s.error_code && Object.hasOwn(gradingProviderErrors, s.error_code))
          detail += `<p role="status">${h(gradingProviderErrors[s.error_code])}</p>`;
        const checked = draft.items.filter((item) => item.reviewed).length;
        const firstPending = Math.max(
          0,
          draft.items.findIndex((item) => !item.reviewed),
        );
        const pageUrl = (page: number) =>
          '/grading/photo?submission=' +
          encodeURIComponent(s.id) +
          '&page=' +
          page;
        if (a.scope) {
          const pictures = Array.from(
            { length: s.expected_pages },
            (_, i) =>
              `<fieldset><legend>제출 사진 ${i + 1}</legend><a href="${pageUrl(i + 1)}" target="_blank" rel="noopener">원본 열기</a>${a.scope!.kind === 'workbook' ? input('printed_' + i, '인쇄된 책 쪽수', String(a.photoPages[i]?.printedPage ?? ''), 'number', 'min="' + a.scope!.from + '" max="' + a.scope!.to + '" required') : ''}${input(
                'numbers_' + i,
                '보이는 문항 번호 (쉼표로 구분)',
                a.items
                  .filter((item) => item.expected_page_no === i + 1)
                  .map((x) => x.item_no)
                  .join(', '),
                'text',
                'required maxlength="500"',
              )}</fieldset>`,
          ).join('');
          detail += `<details${draft.items.length ? '' : ' open'}><summary>${draft.items.length ? '인식한 문항 범위 수정' : '원본에서 문항 범위 확인'}</summary>${startForm('map_pages')}${hidden('submission', s.id)}${hidden('revision', draft.draft_revision)}${pictures}<p>범위를 다시 적용하면 현재 검수 초안을 새로 만듭니다.</p><button>범위 적용·초안 다시 만들기</button></form></details>`;
        }
        if (draft.items.length)
          detail += `<div class="grade-review" data-review data-initial="${firstPending}"><header class="grade-overview"><div><p>사진 채점 / 제출 검수</p><h2>${h(a.title)} · ${h(students.find((student) => student.id === s.student)?.name)}</h2></div><span class="grade-status">검수 전 점수 비공개</span></header><ol class="grade-steps"><li>제출</li><li>AI 초안</li><li aria-current="step">교사 검수</li><li>결과 공개</li></ol>
        <div class="grade-spread"><section class="grade-paper" data-jump-label="제출 사진"><header><h3>제출 답안</h3><label>쪽 <select data-page-select>${Array.from({ length: s.expected_pages }, (_, n) => `<option value="${n + 1}">${n + 1} / ${s.expected_pages}</option>`).join('')}</select></label></header>
        <div class="grade-tools" data-enhance hidden><button type="button" data-turn>회전</button><button type="button" data-zoom>확대</button><button type="button" data-fit>맞춤</button></div>
        ${Array.from({ length: s.expected_pages }, (_, n) => `<figure data-page="${n + 1}"><div class="grade-image"><img src="${pageUrl(n + 1)}" alt="${n + 1}쪽 전체 사진" loading="lazy"></div><figcaption><a href="${pageUrl(n + 1)}" target="_blank" rel="noopener">${n + 1}쪽 원본 크기로 열기</a></figcaption></figure>`).join('')}</section>
        <section class="grade-decisions" data-jump-label="문항 검수">${startForm('review')}${hidden('submission', s.id)}${hidden('revision', draft.draft_revision)}${draft.items
          .map((d, n) => {
            const def = a.items.find(
              (item) => item.item_ref === d.extraction.item_ref,
            )!;
            const p = 'r' + n + '_';
            const computed = propose(def, d.extraction);
            const key = def.key;
            const answerKey =
              key?.approval_status === 'approved'
                ? [
                    ...new Set(
                      [
                        key.numeric_target,
                        ...key.accepted_texts,
                        ...key.accepted_choice_sets.map((set) =>
                          set.join(', '),
                        ),
                      ].filter(Boolean),
                    ),
                  ].join(' / ') || '채점 기준 참조'
                : '승인된 정답 없음';
            return `<fieldset data-review-item="${n}" data-item-page="${def.expected_page_no}"><legend>문항 ${a.scope ? def.expected_page_no + '번째 사진 · ' : ''}${h(def.item_no)} · ${subjectNames[def.subject_id]} · ${h(def.skill_label)}</legend>${d.extraction.regions.length ? `<details><summary>AI 추정 답안 영역 보기</summary><img class="grade-crop" loading="lazy" src="${pageUrl(def.expected_page_no)}&item=${encodeURIComponent(def.item_ref)}" alt="${h(def.item_no)}번 추정 영역"></details>` : ''}<label>읽은 답안<textarea name="${p}answer" maxlength="12000">${h(d.extraction.answer_observed)}</textarea></label>${def.grading_mode === 'photo_solution' ? `<section class="grade-key"><strong>AI가 푼 답</strong><p>${h(d.solution?.answer ?? '풀이 확인 필요')}</p>${d.solution ? `<p>${h(d.solution.explanation)}</p><details><summary>AI가 읽은 문제</summary><p>${h(d.solution.problem)}</p></details>` : `<p>${d.proposed.exclusion_reason === 'PROVIDER_UNAVAILABLE' ? 'AI 호출을 완료하지 못했습니다.' : '문제 전체와 풀이 근거를 원본에서 확인해 주세요.'}</p>`}${input(p + 'reference', '교사가 바로잡은 정답 (필요한 경우)', d.review_reference ?? '', 'text', 'maxlength="1200"')}</section>` : `<div class="grade-key"><strong>등록 정답</strong><span>${h(answerKey)}</span></div>`}${input(p + 'unit', '적힌 단위', d.extraction.unit_observed)}${choice(p + 'answer_status', '판독 상태', ['readable', 'blank', 'unreadable', 'ambiguous'], d.extraction.answer_status, { readable: '읽음', blank: '빈 답안 영역 확인', unreadable: '읽을 수 없음', ambiguous: '여러 답·지움 등 불명확' })}<label class="grade-check"><input type="checkbox" name="${p}located" value="yes"${d.extraction.association_status === 'matched' ? ' checked' : ''}>이 문항의 답안과 위치가 맞습니다.</label><p class="grade-verdict">AI 초안 · ${outcomeNames[(d.initial_proposal ?? d.proposed).outcome]} · ${h((d.initial_proposal ?? d.proposed).score ?? '점수 없음')} / ${h(def.max_score)}</p>${choice(p + 'outcome', '교사 판정', Object.keys(outcomeNames), d.proposed.outcome, outcomeNames)}${def.criteria.map((c, i) => choice(p + 'score_' + i, `${c.label} (${c.max_score}점)`, c.allowed_scores, d.proposed.criteria_scores.find((x) => x.criterion_id === c.criterion_id)?.score ?? computed.criteria_scores.find((x) => x.criterion_id === c.criterion_id)?.score ?? '0')).join('')}<label class="grade-check"><input type="checkbox" name="${p}reviewed" value="yes"${d.reviewed ? ' checked' : ''}>답안·판정·점수·유형을 확인했습니다.</label></fieldset>`;
          })
          .join('')}<button>검수 내용 저장</button></form></section></div>
        <nav class="grade-items" aria-label="검수 문항" data-enhance hidden>${draft.items.map((d, n) => `<button type="button" data-select-item="${n}" data-reviewed="${d.reviewed}" aria-label="문항 ${h(a.items.find((i) => i.item_ref === d.extraction.item_ref)?.item_no)} · ${d.reviewed ? '확인' : '확인 필요'}">${h(a.items.find((i) => i.item_ref === d.extraction.item_ref)?.item_no)}</button>`).join('')}</nav>
        <footer class="grade-footer" data-jump-label="검수 확정"><strong>${checked} / ${draft.items.length}문항 확인 · ${draft.items.length - checked}문항 남음</strong>${startForm('confirm')}${hidden('submission', s.id)}${hidden('revision', draft.draft_revision)}<label><input type="checkbox" name="review_complete" value="yes" required>제출 사진의 문항 범위·누락 여부와 모든 판정을 확인했으며 확정 후 원문·전사·임시 응답 삭제에 동의합니다.</label><button${checked === draft.items.length ? '' : ' disabled'}>확정하고 원문 삭제</button></form></footer></div>`;
      }
      if (s.raw_state !== 'VERIFIED')
        detail += `${startForm('cancel')}${hidden('submission', s.id)}<button class="secondary">처리 취소·임시자료 삭제</button></form>`;
      if (staff && s.raw_state === 'PURGE_RETRY')
        detail += `${startForm('purge')}${hidden('submission', s.id)}<button>삭제 다시 확인</button></form>`;
      detail += '</section>';
    }
    const reportId = ctx.url.searchParams.get('report');
    if (reportId) {
      const report = readReport(ctx, reportId);
      if (staff && report.generation_error)
        detail +=
          '<p role="status">AI 응답을 확인하지 못해 확정 통계로 정형 초안을 만들었습니다. 아래 내용을 검수해 주세요.</p>';
      const basis = readSnapshot(ctx, report.snapshot_id);
      const cited = new Set(report.observations.flatMap((o) => o.fact_ids));
      const stats = basis.facts.filter(
        (f) =>
          cited.has(f.fact_id) &&
          f.period_role === 'primary' &&
          f.n_evaluable > 0,
      );
      const sections = [
        ...(stats.length
          ? [
              '## 성취도',
              [
                '| 학습 유형 | 정답 | 전체 |',
                '| --- | ---: | ---: |',
                ...stats.map(
                  (f) =>
                    '| ' +
                    (f.skill_label || subjectNames[f.subject_id])
                      .replaceAll('|', '｜')
                      .replace(/\s+/g, ' ') +
                    ' | ' +
                    f.n_correct +
                    ' | ' +
                    f.n_evaluable +
                    ' |',
                ),
              ].join('\n'),
            ]
          : []),
        '## 학습 분석',
        report.rendered_text.split('\n').join('\n\n'),
      ].join('\n\n');
      detail += renderReportDocument(
        report.assignment_title || '학습 리포트',
        sections,
        (report.status === 'approved' ? '공개' : '검토 대기') +
          ' · ' +
          report.generated_at.slice(0, 10),
        '과제-학습-리포트',
      );
      if (staff && report.status === 'draft')
        detail += `<section class="panel">${startForm('approve_report')}${hidden('report', report.report_id)}${hidden('revision', report.revision)}${hidden('generation', report.source_generation)}${hidden('hash', report.facts_hash)}<label><input type="checkbox" name="review_complete" value="yes" required>근거와 내용을 검수했습니다.</label><button>학생·보호자에게 공개</button></form></section>`;
    }

    const params = ctx.url.searchParams;
    const tabs: [string, string][] = staff
      ? [
          ['queue', '제출 검수'],
          ['register', '과제 등록'],
          ['upload', '대리 제출'],
          ['reports', '채점 리포트'],
        ]
      : ctx.actor.role === 'student'
        ? [
            ['upload', '숙제 제출'],
            ['queue', '제출 현황'],
            ['results', '채점 결과'],
            ['reports', '채점 리포트'],
          ]
        : [
            ['results', '채점 결과'],
            ['reports', '학습 리포트'],
            ['queue', '제출 현황'],
            ['upload', '자녀 숙제 제출'],
          ];
    const view =
      requestedView ??
      (reportId ? 'reports' : id || params.has('queue') ? 'queue' : tabs[0][0]);
    if (!tabs.some(([key]) => key === view))
      throw new GradingError('RESOURCE_NOT_FOUND', 404);
    const title = staff
      ? '사진 채점'
      : view === 'upload'
        ? '숙제 제출'
        : view === 'queue'
          ? '제출 현황'
          : view === 'reports'
            ? ctx.actor.role === 'guardian'
              ? '학습 리포트'
              : '채점 리포트'
            : '채점 결과';
    const intro =
      `<script src="/grading-ui.js?v=2" defer></script><div class="page-heading"><h1>${title}</h1></div><nav class="grade-filters" aria-label="숙제 메뉴">` +
      tabs
        .map(
          ([key, label]) =>
            `<a href="/grading?view=${key}"${view === key ? ' aria-current="page"' : ''}>${label}</a>`,
        )
        .join('') +
      '</nav>';
    if (detail) return intro + detail;
    if (view === 'register')
      return (
        intro +
        '<section class="panel">' +
        gradingAvailability(service, service.allowsPersonalPractice(ctx)) +
        registerForm(ctx) +
        '</section>'
      );
    const assignmentId = params.get('assignment');
    const requestedAssignment = assignments.find(
      (a) => a.assignment_id === assignmentId,
    );
    if (assignmentId && !requestedAssignment)
      throw new GradingError('RESOURCE_NOT_FOUND', 404);
    if (view === 'upload') {
      const target = id ? readSubmission(ctx, id, true) : undefined;
      const selected = target
        ? assignments.find((a) => a.assignment_id === target.assignment)
        : (requestedAssignment ?? assignments[0]);
      const eligible = students.filter(
        (s) =>
          s.classIds.includes(selected?.class_id ?? '') &&
          (!target || target.student === s.id),
      );
      const picker =
        !target && assignments.length > 1
          ? `<form method="get" action="/grading" class="inline-form">${hidden('view', 'upload')}${choice(
              'assignment',
              '제출할 과제',
              assignments.map((a) => a.assignment_id),
              selected?.assignment_id ?? '',
              Object.fromEntries(
                assignments.map((a) => [a.assignment_id, a.title]),
              ),
            )}<button>과제 선택</button></form>`
          : '';
      const mediaLimits = gradingMediaLimits(ctx.maxDocumentBytes);
      const canPractice =
        !!selected &&
        eligible.some((s) =>
          service.canSubmitPractice(ctx, s.id, selected, !!target),
        );
      const practiceChoice =
        canPractice && !service.provider.inputAllowed
          ? '<label class="grade-check"><input type="checkbox" name="practice" value="yes"' +
            (service.practicePolicy === demoPhotoPolicy ? ' required' : '') +
            '>이름·학교·얼굴이 없는 연습 답안이며, 이 제출의 사진을 네이버 CLOVA로 보내 채점하는 데 동의합니다.</label>'
          : '';
      return (
        intro +
        `<section class="panel grade-upload"><h2>${staff ? '대리 제출' : '과제와 답안'}</h2>${picker}${
          selected && eligible.length
            ? `<form method="post" action="/grading" enctype="multipart/form-data">${hidden('action', 'upload')}${hidden('request_key', newId('request'))}${hidden('assignment', selected.assignment_id)}<p><strong>${h(selected.title)}</strong> · ${selected.scope ? (selected.scope.kind === 'workbook' ? '책 쪽수와 문항 번호가 보이게 촬영 · 긴 범위는 나누어 제출 가능' : '나눠 준 문제지의 문항 번호가 보이게 촬영') : selected.items.length + '문항'}</p>${
                eligible.length === 1
                  ? hidden('student', eligible[0].id)
                  : choice(
                      'student',
                      '학생',
                      eligible.map((s) => s.id),
                      target?.student ?? '',
                      Object.fromEntries(eligible.map((s) => [s.id, s.name])),
                    )
              }<label class="grade-picker" data-jump-label="사진 첨부"><strong>사진 또는 PDF 추가</strong><span>문제·지문·보기와 내가 쓴 답이 한눈에 보이도록 찍어 주세요.</span><input type="file" name="photos" data-max-files="${mediaLimits.pages}" data-max-bytes="${mediaLimits.bytes}" data-max-pixels="${mediaLimits.pixels}" accept="image/jpeg,image/png,image/webp,application/pdf" multiple required></label><p class="muted">한 번에 ${mediaLimits.pages}쪽 · 전체 ${Math.floor(mediaLimits.bytes / 1024 / 1024)} MB 이하</p><p data-file-status aria-live="polite"></p><div class="grade-previews" data-previews></div>${practiceChoice}${staff && target?.result_id && target.published_revision ? `<label><input type="checkbox" name="target" value="${h(target.result_id)}">다시 푼 답안이 아닌, 위 성적의 같은 답안을 재촬영한 정정 증거입니다.</label>${hidden('target_revision', target.current_revision)}` : ''}<button>숙제 제출</button><details class="grade-details"><summary>사진 보관과 결과 공개</summary>${gradingAvailability(service, canPractice)}<p>원본은 검수 전 최대 ${Math.round(service.ttl / 60000)}분 보관합니다. 선생님이 결과를 확인하고 원본 삭제가 확인되면 결과가 공개됩니다.</p><p>사진은 한 장당 ${mediaLimits.pixels / 10000}만 화소까지 첨부할 수 있습니다.</p></details></form>`
            : '<p>제출할 수 있는 사진 채점 과제가 없습니다.</p>'
        }${ctx.actor.academyId === 'AC_TEST_A' ? '<details class="grade-samples"><summary>연습용 답안 내려받기</summary><p>한 페이지씩 사진을 추가하거나 여러 페이지를 PDF 한 파일로 제출할 수 있습니다.</p><div><a download href="/assets/practice-math-1.png">1쪽 사진</a><a download href="/assets/practice-math-2.png">2쪽 사진</a><a download href="/assets/practice-math.pdf">두 쪽 PDF</a></div></details>' : ''}</section>`
      );
    }
    if (view === 'reports') {
      const visible = new Set(students.map((s) => s.id));
      const reports = rows<{ id: string; student: string; status: string }>(
        ctx.db,
        "SELECT id,student,status FROM grading_v3_reports WHERE tenant=? AND status<>'stale' ORDER BY rowid DESC",
        ctx.actor.academyId,
      )
        .filter(
          (r) => visible.has(r.student) && (staff || r.status === 'approved'),
        )
        .flatMap((r) => {
          try {
            return [{ ...readReport(ctx, r.id), student: r.student }];
          } catch (error) {
            if (
              error instanceof GradingError &&
              [403, 404, 409].includes(error.status)
            )
              return [];
            throw error;
          }
        });
      const list =
        '<section class="panel"><h2>과제별 채점 리포트</h2>' +
        (reports
          .map(
            (r) =>
              `<a class="grade-report-row" href="/grading?report=${encodeURIComponent(r.report_id)}"><strong>${h(students.find((s) => s.id === r.student)?.name)} · ${h(r.assignment_title || '학습 리포트')}</strong><span>${r.status === 'approved' ? '공개' : '검토 대기'} · ${h(r.generated_at.slice(0, 10))} ›</span></a>`,
          )
          .join('') || '<p>조회 가능한 리포트가 없습니다.</p>') +
        '</section>';
      return (
        intro +
        (ctx.actor.role === 'guardian' ? renderStudentReports(ctx) : '') +
        list +
        (staff
          ? `<section class="panel"><h2>분석 리포트 만들기</h2>${startForm('report')}${choice(
              'student',
              '학생',
              students.map((s) => s.id),
              '',
              Object.fromEntries(students.map((s) => [s.id, s.name])),
            )}<div class="form-grid">${input('from', '기간 시작', kstDate(service.now()).slice(0, 8) + '01', 'date', 'required')}${input('to', '기간 끝 — 해당 날짜 미포함', kstDate(service.now() + 86400000), 'date', 'required')}${input('compare_from', '비교 기간 시작 — 선택', '', 'date')}${input('compare_to', '비교 기간 끝 — 해당 날짜 미포함', '', 'date')}</div><fieldset class="grade-subjects"><legend>분석 과목</legend>${subjects.map((s) => `<label><input type="checkbox" name="subject" value="${s}" checked>${subjectNames[s]}</label>`).join('')}</fieldset>${choice('attempt', '반복 풀이 집계', ['first_ever', 'latest_in_window'], 'first_ever', { first_ever: '기록된 첫 풀이', latest_in_window: '기간 내 최근 풀이' })}<button>확정 기록으로 초안 생성</button></form></section>`
          : '')
      );
    }
    const queues = {
      all: overview.entries,
      review: overview.review,
      purge: overview.purge,
    };
    const filter = params.get('queue');
    const queue =
      staff && (filter === 'review' || filter === 'purge') ? filter : 'all';
    const selectedEntries = (
      view === 'results' ? overview.results : queues[queue]
    ).filter((s) => !assignmentId || s.assignment === assignmentId);
    const suffix = assignmentId
      ? '&amp;assignment=' + encodeURIComponent(assignmentId)
      : '';
    const assignmentFilter =
      staff && assignments.length
        ? `<form method="get" action="/grading" class="inline-form">${hidden('queue', queue)}${choice('assignment', '과제별 제출 현황', ['', ...assignments.map((a) => a.assignment_id)], assignmentId ?? '', { '': '전체 과제', ...Object.fromEntries(assignments.map((a) => [a.assignment_id, a.title])) })}<button>조회</button></form>`
        : '';
    const filters = staff
      ? `<nav class="grade-filters" aria-label="제출 상태">${(['all', 'review', 'purge'] as const).map((k) => `<a href="/grading?queue=${k}${suffix}#grade-queue"${queue === k ? ' aria-current="page"' : ''}>${{ all: '전체', review: '확인 필요', purge: '삭제 확인' }[k]} ${queues[k].filter((s) => !assignmentId || s.assignment === assignmentId).length}</a>`).join('')}</nav>`
      : '';
    return (
      intro +
      `<section class="panel" id="grade-queue"><h2>${view === 'results' ? '공개된 채점 결과' : staff ? '제출·검수 현황' : '제출 현황'}</h2>${requestedAssignment ? `<h3>${h(requestedAssignment.title)}</h3>` : ''}${assignmentFilter}${filters}${
        selectedEntries.length
          ? `<ul class="grade-queue-list">${selectedEntries.map((s) => `<li><a class="grade-queue-entry" href="${h(s.href)}"><strong>${h(s.title)}</strong><span class="grade-student">${h(s.studentName)}</span><span class="pill">${h(names[s.processing])}</span></a></li>`).join('')}</ul>`
          : `<p class="muted">${view === 'results' ? '공개된 채점 결과가 없습니다.' : queue === 'all' ? '제출된 숙제가 없습니다.' : '이 상태의 제출이 없습니다.'}</p>`
      }</section>`
    );
  } catch (error) {
    gradingError(error);
  }
}
export async function gradingPhoto(ctx: PageContext) {
  try {
    const service = gradingService(ctx.db),
      id = ctx.url.searchParams.get('submission') ?? '',
      page = Number(ctx.url.searchParams.get('page'));
    const original = await service.photo(ctx, id, page);
    const item = ctx.url.searchParams.get('item');
    if (!item) return original;
    const draft = await service.draft(ctx, id),
      reading = draft.items.find(
        (i) => i.extraction.item_ref === item,
      )?.extraction;
    if (!reading) throw new GradingError('RESOURCE_NOT_FOUND', 404);
    try {
      const crop = await cropAnswer({ ...original, page_no: page }, reading);
      if (!crop) throw new GradingError('INPUT_UNREADABLE');
      return { ...original, bytes: crop.bytes, mime: crop.mime };
    } finally {
      original.bytes.fill(0);
    }
  } catch (error) {
    gradingError(error);
  }
}
export const gradingModule: OperationModule = {
  path: '/grading',
  label: '사진 채점',
  roles: ['admin', 'teacher', 'student', 'guardian'],
  setup: (db) => {
    setupGrading(db);
  },
  render,
  submit,
};
