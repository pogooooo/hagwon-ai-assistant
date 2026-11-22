import { z } from 'zod';
import {
  date,
  GradingError,
  parse,
  subjects,
  subjectNames,
  type Result,
  type Assignment,
  type Subject,
} from './contracts.ts';
import { decimalString, points, rate } from './arithmetic.ts';
import {
  assignmentFor,
  submissionAssignment,
  digest,
  newId,
  requireStaff,
  requireStudent,
  sourceGeneration,
  type GradingService,
  type Submission,
} from './service.ts';
import {
  one,
  rows,
  transaction,
  type PageContext,
} from '../academy-operations/shared.ts';
import { accessibleClasses } from '../academy-operations/directory.ts';
import type { OperationsDatabase } from '../academy-operations/database.ts';

const period = z
  .object({ from_date: date, to_date_exclusive: date })
  .strict()
  .refine((v) => v.from_date < v.to_date_exclusive);
export const querySchema = z
  .object({
    student_ref: z.string().min(1),
    from_date: date,
    to_date_exclusive: date,
    comparison_period: period.nullable().default(null),
    subjects: z.array(z.enum(subjects)).min(1).max(3),
    attempt_policy: z.enum(['first_ever', 'latest_in_window']),
    statistics_policy_version: z
      .literal('grading-stats-3.0')
      .default('grading-stats-3.0'),
  })
  .strict()
  .refine(
    (v) =>
      v.from_date < v.to_date_exclusive &&
      new Set(v.subjects).size === v.subjects.length &&
      (!v.comparison_period ||
        v.comparison_period.to_date_exclusive <= v.from_date),
  );
export type FactsQuery = z.infer<typeof querySchema>;
export interface Fact {
  fact_id: string;
  period_role: 'primary' | 'comparison';
  subject_id: Subject;
  primary_skill_id: string | null;
  skill_label?: string | null;
  taxonomy_version: string | null;
  n_correct: number;
  n_incorrect: number;
  n_partial: number;
  n_blank: number;
  n_ungradable: number;
  n_excluded: number;
  n_evaluable: number;
  score_sum: string;
  max_score_sum: string;
  correct_rate: string | null;
  score_rate: string | null;
  sample_state: 'available' | 'insufficient';
}
export interface Selection {
  period_role: 'primary' | 'comparison';
  submission_id: string;
  assignment_id: string;
  assignment_version: number;
  attempt_no: number;
  assessment_date: string;
  bucket: 'published' | 'pending' | 'unavailable';
  result_set_id: string | null;
  result_revision: number | null;
  item_refs: string[];
}
export interface Snapshot {
  snapshot_id: string;
  tenant_id: string;
  student_ref: string;
  generated_at: string;
  source_generation: number;
  query: FactsQuery;
  result_refs: {
    result_set_id: string;
    revision: number;
    item_refs: string[];
  }[];
  selection_refs: Selection[];
  facts: Fact[];
  availability: {
    period_role: 'primary' | 'comparison';
    subject_id: Subject;
    n_selected_items: number;
    n_published_items: number;
    n_pending_items: number;
    n_unavailable_items: number;
  }[];
  taxonomy_versions: string[];
  facts_hash: string;
  hash_algorithm_version: 'axr-facts-c14n-1';
  statistics_policy_version: 'grading-stats-3.0';
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
/** Snapshot computation and storage run within one short SQLite/DO transaction. */
export function computeFacts(
  db: OperationsDatabase,
  tenant: string,
  query: FactsQuery,
  now = Date.now(),
  allowedClasses?: ReadonlySet<string>,
  submissionId?: string,
): Snapshot {
  const q = parse(querySchema, query);
  const submissions = rows<Submission>(
    db,
    "SELECT * FROM grading_v3_submissions WHERE tenant=? AND student=? AND purpose='assessment' AND uploaded=1 AND attempt_no IS NOT NULL" +
      (submissionId ? ' AND id=?' : '') +
      ' ORDER BY attempt_no,id',
    tenant,
    q.student_ref,
    ...(submissionId ? [submissionId] : []),
  );
  const facts: Fact[] = [],
    selections: Selection[] = [],
    refs = new Map<
      string,
      { result_set_id: string; revision: number; item_refs: string[] }
    >();
  const availability: Snapshot['availability'] = [];
  const periods = [
    {
      period_role: 'primary' as const,
      from_date: q.from_date,
      to_date_exclusive: q.to_date_exclusive,
    },
    ...(q.comparison_period
      ? [{ period_role: 'comparison' as const, ...q.comparison_period }]
      : []),
  ];
  for (const p of periods) {
    // Different book pages can arrive in separate uploads. Replace only an overlapping
    // page on a later attempt; an unidentified upload cannot safely reuse older scores.
    type Attempt = { submission: Submission; items: Assignment['items'] };
    const groups = new Map<string, Map<number, Attempt>>();
    for (const s of submissions) {
      const inWindow =
        p.from_date <= s.assessment_date &&
        s.assessment_date < p.to_date_exclusive;
      if (q.attempt_policy === 'latest_in_window' && !inWindow) continue;
      const a = submissionAssignment(db, s);
      if (allowedClasses && !allowedClasses.has(a.class_id)) continue;
      const key = s.assignment + ':' + s.assignment_version;
      const pages = groups.get(key) ?? new Map<number, Attempt>();
      groups.set(key, pages);
      const first = q.attempt_policy === 'first_ever';
      if (first && pages.has(0)) continue;
      if (a.scope?.kind === 'workbook' && a.photoPages.length) {
        for (const [i, page] of a.photoPages.entries()) {
          if (!first || !pages.has(page.printedPage!))
            pages.set(page.printedPage!, {
              submission: s,
              items: a.items.filter((item) => item.expected_page_no === i + 1),
            });
        }
      } else if (!first || !pages.size) {
        pages.clear();
        pages.set(0, { submission: s, items: a.items });
      }
    }
    const chosen = new Map<string, Attempt>();
    for (const pages of groups.values()) {
      for (const { submission, items } of pages.values()) {
        const previous = chosen.get(submission.id);
        if (previous) previous.items.push(...items);
        else chosen.set(submission.id, { submission, items: [...items] });
      }
    }
    for (const subject of q.subjects) {
      const totals = new Map<string, Fact>();
      const create = (
        skill: string | null,
        taxonomy: string | null,
        label?: string,
      ) => {
        const key = JSON.stringify([skill, taxonomy]);
        let f = totals.get(key);
        if (!f) {
          f = {
            fact_id: newId('fact'),
            period_role: p.period_role,
            subject_id: subject,
            primary_skill_id: skill,
            skill_label: skill ? (label ?? null) : null,
            taxonomy_version: taxonomy,
            n_correct: 0,
            n_incorrect: 0,
            n_partial: 0,
            n_blank: 0,
            n_ungradable: 0,
            n_excluded: 0,
            n_evaluable: 0,
            score_sum: '0',
            max_score_sum: '0',
            correct_rate: null,
            score_rate: null,
            sample_state: 'insufficient',
          };
          totals.set(key, f);
        }
        return f;
      };
      const overall = create(null, null);
      const available = {
        period_role: p.period_role,
        subject_id: subject,
        n_selected_items: 0,
        n_published_items: 0,
        n_pending_items: 0,
        n_unavailable_items: 0,
      };
      for (const { submission: s, items } of chosen.values()) {
        if (!(
          p.from_date <= s.assessment_date &&
          s.assessment_date < p.to_date_exclusive
        ))
          continue;
        const expected = items.filter((i) => i.subject_id === subject);
        if (!expected.length) continue;
        let result: Result | undefined;
        if (
          s.result_id &&
          s.current_revision === s.published_revision &&
          s.published_revision !== null
        ) {
          const row = one<{ payload: string }>(
            db,
            'SELECT payload FROM grading_v3_results WHERE tenant=? AND id=? AND revision=?',
            tenant,
            s.result_id,
            s.current_revision,
          );
          if (row) {
            const candidate = JSON.parse(row.payload) as Result;
            if (
              db
                .prepare(
                  'SELECT 1 FROM grading_v3_receipts WHERE tenant=? AND scope=? AND generation=?',
                )
                .get(tenant, candidate.raw_scope_id, candidate.raw_generation)
            )
              result = candidate;
          }
        }
        const bucket = result
          ? ('published' as const)
          : ['CANCELLED', 'EXPIRED', 'FAILED'].includes(s.processing)
            ? ('unavailable' as const)
            : ('pending' as const);
        available.n_selected_items += expected.length;
        available[`n_${bucket}_items`] += expected.length;
        selections.push({
          period_role: p.period_role,
          submission_id: s.id,
          assignment_id: s.assignment,
          assignment_version: s.assignment_version,
          attempt_no: s.attempt_no!,
          assessment_date: s.assessment_date,
          bucket,
          result_set_id: s.result_id,
          result_revision: s.current_revision,
          item_refs: expected.map((i) => i.item_ref).sort(),
        });
        if (!result) continue;
        for (const def of expected) {
          const item = result.items.find((i) => i.item_ref === def.item_ref);
          if (!item) throw new GradingError('ITEM_SET_MISMATCH');
          for (const f of [
            overall,
            create(
              item.primary_skill_id,
              item.taxonomy_version,
              def.skill_label,
            ),
          ]) {
            f[`n_${item.outcome}`]++;
            if (
              ['correct', 'incorrect', 'partial', 'blank'].includes(
                item.outcome,
              )
            ) {
              f.n_evaluable++;
              f.score_sum = decimalString(
                points(f.score_sum) + points(item.score!),
              );
              f.max_score_sum = decimalString(
                points(f.max_score_sum) + points(item.max_score),
              );
            }
          }
          const key = result.result_set_id + ':' + result.revision;
          const ref = refs.get(key) ?? {
            result_set_id: result.result_set_id,
            revision: result.revision,
            item_refs: [],
          };
          if (!ref.item_refs.includes(item.item_ref))
            ref.item_refs.push(item.item_ref);
          refs.set(key, ref);
        }
      }
      for (const f of totals.values()) {
        f.correct_rate = rate(BigInt(f.n_correct), BigInt(f.n_evaluable));
        f.score_rate = rate(points(f.score_sum), points(f.max_score_sum));
        // A descriptive minimum sample size, not a mastery or statistical significance assertion.
        f.sample_state = f.n_evaluable >= 5 ? 'available' : 'insufficient';
        facts.push(f);
      }
      availability.push(available);
    }
  }
  const snapshot: Snapshot = {
    snapshot_id: newId('snapshot'),
    tenant_id: tenant,
    student_ref: q.student_ref,
    generated_at: new Date(now).toISOString(),
    source_generation: sourceGeneration(db, tenant, q.student_ref),
    query: q,
    result_refs: [...refs.values()]
      .map((r) => ({ ...r, item_refs: r.item_refs.sort() }))
      .sort(
        (a, b) =>
          a.result_set_id.localeCompare(b.result_set_id) ||
          a.revision - b.revision,
      ),
    selection_refs: selections.sort((a, b) =>
      JSON.stringify([
        a.period_role,
        a.assignment_id,
        a.assignment_version,
        a.attempt_no,
        a.submission_id,
        a.bucket,
      ]).localeCompare(
        JSON.stringify([
          b.period_role,
          b.assignment_id,
          b.assignment_version,
          b.attempt_no,
          b.submission_id,
          b.bucket,
        ]),
      ),
    ),
    facts: facts.sort((a, b) =>
      [
        a.period_role,
        a.subject_id,
        a.primary_skill_id ?? '',
        a.taxonomy_version ?? '',
        a.fact_id,
      ]
        .join(':')
        .localeCompare(
          [
            b.period_role,
            b.subject_id,
            b.primary_skill_id ?? '',
            b.taxonomy_version ?? '',
            b.fact_id,
          ].join(':'),
        ),
    ),
    availability: availability.sort((a, b) =>
      [a.period_role, a.subject_id]
        .join(':')
        .localeCompare([b.period_role, b.subject_id].join(':')),
    ),
    taxonomy_versions: [
      ...new Set(
        facts.flatMap((f) => (f.taxonomy_version ? [f.taxonomy_version] : [])),
      ),
    ].sort(),
    facts_hash: '',
    hash_algorithm_version: 'axr-facts-c14n-1',
    statistics_policy_version: 'grading-stats-3.0',
  };
  const {
    tenant_id,
    student_ref,
    source_generation,
    result_refs,
    selection_refs,
    availability: av,
    taxonomy_versions,
    hash_algorithm_version,
    statistics_policy_version,
  } = snapshot;
  snapshot.facts_hash = digest(
    canonical({
      tenant_id,
      student_ref,
      source_generation,
      query: q,
      result_refs,
      selection_refs,
      facts: snapshot.facts,
      availability: av,
      taxonomy_versions,
      hash_algorithm_version,
      statistics_policy_version,
    }),
  );
  return snapshot;
}
export function snapshot(ctx: PageContext, value: unknown, now?: number) {
  const query = parse(querySchema, value);
  requireStudent(ctx, query.student_ref);
  return transaction(ctx.db, () => {
    const result = computeFacts(
      ctx.db,
      ctx.actor.academyId,
      query,
      now,
      new Set(accessibleClasses(ctx.db, ctx.actor).map((c) => c.id)),
    );
    ctx.db
      .prepare('INSERT INTO grading_v3_snapshots VALUES(?,?,?,?,?)')
      .run(
        result.snapshot_id,
        result.tenant_id,
        result.student_ref,
        result.source_generation,
        JSON.stringify(result),
      );
    return result;
  });
}
export function readSnapshot(ctx: PageContext, id: string) {
  const row = one<{ student: string; generation: number; payload: string }>(
    ctx.db,
    'SELECT * FROM grading_v3_snapshots WHERE tenant=? AND id=?',
    ctx.actor.academyId,
    id,
  );
  if (!row) throw new GradingError('RESOURCE_NOT_FOUND', 404);
  requireStudent(ctx, row.student);
  const pinned = one<{ current: number }>(
    ctx.db,
    "SELECT EXISTS(SELECT 1 FROM grading_v3_submissions s WHERE s.tenant=p.tenant AND s.result_id=p.result AND s.current_revision=p.revision AND s.published_revision=p.revision AND s.purpose='assessment') AS current FROM grading_v3_result_reports p WHERE p.tenant=? AND p.snapshot=?",
    ctx.actor.academyId,
    id,
  );
  if (
    pinned
      ? !pinned.current
      : row.generation !==
        sourceGeneration(ctx.db, ctx.actor.academyId, row.student)
  )
    throw new GradingError('SNAPSHOT_STALE', 409);
  const result = JSON.parse(row.payload) as Snapshot;
  const classes = new Set(
    accessibleClasses(ctx.db, ctx.actor).map((c) => c.id),
  );
  if (
    result.selection_refs.some(
      (s) =>
        !classes.has(
          assignmentFor(
            ctx.db,
            ctx.actor.academyId,
            s.assignment_id,
            s.assignment_version,
          ).class_id,
        ),
    )
  )
    throw new GradingError('RESOURCE_NOT_FOUND', 404);
  return result;
}

export const observationSchema = z
  .object({
    claim_type: z.enum([
      'observed_rate',
      'observed_score',
      'insufficient_evidence',
      'study_suggestion',
      'observed_change',
    ]),
    fact_ids: z.array(z.string()).min(1).max(2),
    template_key: z.enum(['rate', 'score', 'insufficient', 'review', 'change']),
  })
  .strict();
export type Observation = z.infer<typeof observationSchema>;
export interface Report {
  assignment_title?: string;
  report_id: string;
  revision: number;
  snapshot_id: string;
  facts_hash: string;
  source_generation: number;
  generated_at: string;
  template_version: 'grading-report-3.0';
  model_id: string;
  generation_error?: string;
  status: 'draft' | 'approved' | 'stale';
  observations: Observation[];
  rendered_text: string;
}
function percent(count: bigint, total: bigint) {
  const value = rate(count * 100n, total);
  return value === null ? '집계 없음' : Number(value).toFixed(1) + '%';
}
export function renderObservations(s: Snapshot, observations: Observation[]) {
  const text: string[] = [
    `평가 기간 ${s.query.from_date} ~ ${s.query.to_date_exclusive} 미만. 시도 기준: ${s.query.attempt_policy === 'first_ever' ? '기록된 첫 풀이' : '기간 내 최근 풀이'}.`,
  ];
  for (const observation of observations) {
    const o = parse(observationSchema, observation),
      facts = o.fact_ids.map((id) => s.facts.find((f) => f.fact_id === id));
    if (facts.some((f) => !f) || new Set(o.fact_ids).size !== o.fact_ids.length)
      throw new GradingError('REPORT_EVIDENCE_MISMATCH');
    const a = facts[0]!;
    const label =
      subjectNames[a.subject_id] +
      (a.primary_skill_id ? ` 유형 ${a.skill_label ?? '등록 유형'}` : ' 전체');
    if (o.claim_type === 'observed_change') {
      const b = facts[1];
      if (
        o.template_key !== 'change' ||
        !b ||
        a.period_role !== 'primary' ||
        b.period_role !== 'comparison' ||
        a.subject_id !== b.subject_id ||
        a.primary_skill_id !== b.primary_skill_id ||
        a.taxonomy_version !== b.taxonomy_version ||
        !a.n_evaluable ||
        !b.n_evaluable
      )
        throw new GradingError('REPORT_EVIDENCE_MISMATCH');
      const delta =
        Number(rate(BigInt(a.n_correct) * 100n, BigInt(a.n_evaluable))) -
        Number(rate(BigInt(b.n_correct) * 100n, BigInt(b.n_evaluable)));
      text.push(
        `${label}: 이전 기간 ${b.n_evaluable}문항과 현재 ${a.n_evaluable}문항의 관측 정답률 차이는 ${delta.toFixed(1)}%p입니다. 과제 난도와 문항 구성이 달라 실력 변화로 단정하지 않습니다.`,
      );
    } else {
      if (facts.length !== 1)
        throw new GradingError('REPORT_EVIDENCE_MISMATCH');
      if (
        o.claim_type === 'observed_rate' &&
        o.template_key === 'rate' &&
        a.n_evaluable
      )
        text.push(
          `${label}: 평가 가능한 ${a.n_evaluable}문항 중 ${a.n_correct}문항 정답, 정답률 ${percent(BigInt(a.n_correct), BigInt(a.n_evaluable))}. 부분 정답 ${a.n_partial}문항, 미응답 ${a.n_blank}문항.`,
        );
      else if (
        o.claim_type === 'observed_score' &&
        o.template_key === 'score' &&
        a.n_evaluable
      )
        text.push(
          `${label}: ${a.max_score_sum}점 중 ${a.score_sum}점, 점수율 ${percent(points(a.score_sum), points(a.max_score_sum))}.`,
        );
      else if (
        o.claim_type === 'insufficient_evidence' &&
        o.template_key === 'insufficient' &&
        a.sample_state === 'insufficient'
      )
        text.push(
          `${label}: 공개된 평가 가능 기록 ${a.n_evaluable}문항으로 자료가 부족합니다. 기록이 적다는 사실만으로 학습 여부나 능력을 판단하지 않습니다.`,
        );
      else if (
        o.claim_type === 'study_suggestion' &&
        o.template_key === 'review' &&
        a.primary_skill_id &&
        a.n_evaluable &&
        a.n_correct < a.n_evaluable
      )
        text.push(
          `${label}: 이번 기록에서 완전 정답으로 확인되지 않은 문항이 있어, 해당 유형을 다시 연습해 보는 것을 제안합니다. 오답 원인을 진단한 결과는 아닙니다.`,
        );
      else throw new GradingError('REPORT_EVIDENCE_MISMATCH');
    }
  }
  for (const subject of s.query.subjects) {
    const overall = s.facts.find(
      (f) =>
        f.period_role === 'primary' &&
        f.subject_id === subject &&
        f.primary_skill_id === null,
    );
    if (
      !overall ||
      !observations.some(
        (o) =>
          o.claim_type !== 'study_suggestion' &&
          o.fact_ids.includes(overall.fact_id),
      )
    )
      throw new GradingError('REPORT_SUBJECT_OMITTED');
  }
  for (const a of s.availability)
    if (a.period_role === 'primary')
      text.push(
        `${subjectNames[a.subject_id]} 선택 ${a.n_selected_items}문항: 공개 ${a.n_published_items}, 검수·삭제 대기 ${a.n_pending_items}, 확인 불가 ${a.n_unavailable_items}. 공개된 판독·채점 불가 및 제외 문항은 정답률·점수율 분모에서 제외합니다.`,
      );
  return text.join('\n\n');
}
function subjectObservations(s: Snapshot): Observation[] {
  return s.facts
    .filter((f) => f.period_role === 'primary' && !f.primary_skill_id)
    .map((f) => ({
      claim_type: f.n_evaluable ? 'observed_rate' : 'insufficient_evidence',
      fact_ids: [f.fact_id],
      template_key: f.n_evaluable ? 'rate' : 'insufficient',
    }));
}

/** Build the draft in a transaction after the deletion receipt and result are committed. */
export function ensureResultReport(
  db: OperationsDatabase,
  tenant: string,
  resultId: string,
  now: number,
) {
  const head = one<Submission>(
    db,
    "SELECT * FROM grading_v3_submissions WHERE tenant=? AND result_id=? AND purpose='assessment' AND current_revision=published_revision",
    tenant,
    resultId,
  );
  if (!head || !head.published_revision) return;
  const existing = one<{ report: string }>(
    db,
    'SELECT report FROM grading_v3_result_reports WHERE tenant=? AND result=? AND revision=?',
    tenant,
    resultId,
    head.published_revision,
  );
  if (existing) return existing.report;
  const a = submissionAssignment(db, head);
  const s = computeFacts(
    db,
    tenant,
    {
      student_ref: head.student,
      from_date: head.assessment_date,
      to_date_exclusive: new Date(
        Date.parse(head.assessment_date + 'T00:00:00Z') + 86400000,
      )
        .toISOString()
        .slice(0, 10),
      subjects: [...new Set(a.items.map((i) => i.subject_id))],
      comparison_period: null,
      attempt_policy: 'latest_in_window',
      statistics_policy_version: 'grading-stats-3.0',
    },
    now,
    undefined,
    head.id,
  );
  if (
    !s.result_refs.some(
      (r) =>
        r.result_set_id === resultId && r.revision === head.published_revision,
    )
  )
    return;
  db.prepare('INSERT INTO grading_v3_snapshots VALUES(?,?,?,?,?)').run(
    s.snapshot_id,
    tenant,
    head.student,
    s.source_generation,
    JSON.stringify(s),
  );
  const observations = subjectObservations(s);
  for (const f of s.facts.filter(
    (fact) => fact.primary_skill_id && fact.n_evaluable,
  )) {
    observations.push({
      claim_type: 'observed_rate',
      fact_ids: [f.fact_id],
      template_key: 'rate',
    });
  }
  for (const f of s.facts.filter(
    (f) => f.primary_skill_id && f.n_incorrect + f.n_partial + f.n_blank > 0,
  )) {
    observations.push({
      claim_type: 'study_suggestion',
      fact_ids: [f.fact_id],
      template_key: 'review',
    });
  }
  const report = storeReport(
    db,
    s,
    now,
    observations,
    'deterministic-template',
    undefined,
    a.title,
  );
  db.prepare('INSERT INTO grading_v3_result_reports VALUES(?,?,?,?,?)').run(
    tenant,
    resultId,
    head.published_revision,
    s.snapshot_id,
    report.report_id,
  );
  db.prepare(
    "UPDATE grading_v3_reports SET status='stale' WHERE id IN (SELECT report FROM grading_v3_result_reports WHERE tenant=? AND result=? AND revision<>?)",
  ).run(tenant, resultId, head.published_revision);
  return report.report_id;
}

export async function generateReport(
  ctx: PageContext,
  service: GradingService,
  snapshotId: string,
) {
  requireStaff(ctx);
  const s = readSnapshot(ctx, snapshotId);
  let observations = subjectObservations(s);
  let model = 'deterministic-template';
  let generationError: string | undefined;
  if (service.provider.report && service.provider.inputAllowed) {
    try {
      // No student identity, problem text, OCR, free-form responses or teacher notes leave this adapter.
      const result = parse(
        z
          .object({ observations: z.array(observationSchema).min(1).max(30) })
          .strict(),
        await service.provider.report({
          facts: s.facts,
          availability: s.availability,
        }),
      );
      renderObservations(s, result.observations);
      observations = result.observations;
      model = service.provider.modelId;
    } catch (error) {
      generationError =
        error instanceof GradingError
          ? error.code
          : 'PROVIDER_TEMPORARY_FAILURE';
    }
  }
  return transaction(ctx.db, () => {
    readSnapshot(ctx, snapshotId);
    requireStaff(ctx);
    return storeReport(
      ctx.db,
      s,
      service.now(),
      observations,
      model,
      generationError,
    );
  });
}
function storeReport(
  db: OperationsDatabase,
  s: Snapshot,
  now: number,
  observations: Observation[],
  model: string,
  generationError?: string,
  assignmentTitle?: string,
) {
  const report: Report = {
    report_id: newId('report'),
    revision: 1,
    snapshot_id: s.snapshot_id,
    ...(assignmentTitle ? { assignment_title: assignmentTitle } : {}),
    facts_hash: s.facts_hash,
    source_generation: s.source_generation,
    generated_at: new Date(now).toISOString(),
    template_version: 'grading-report-3.0',
    model_id: model,
    ...(generationError ? { generation_error: generationError } : {}),
    status: 'draft',
    observations,
    rendered_text: renderObservations(s, observations),
  };
  db.prepare('INSERT INTO grading_v3_reports VALUES(?,?,?,?,?,?,?)').run(
    report.report_id,
    s.tenant_id,
    s.student_ref,
    1,
    s.source_generation,
    'draft',
    JSON.stringify(report),
  );
  return report;
}
export function readReport(ctx: PageContext, id: string) {
  const row = one<{ payload: string; student: string; status: string }>(
    ctx.db,
    'SELECT * FROM grading_v3_reports WHERE tenant=? AND id=?',
    ctx.actor.academyId,
    id,
  );
  if (!row) throw new GradingError('RESOURCE_NOT_FOUND', 404);
  requireStudent(ctx, row.student);
  if (row.status === 'stale') throw new GradingError('SNAPSHOT_STALE', 409);
  const r = JSON.parse(row.payload) as Report;
  const s = readSnapshot(ctx, r.snapshot_id);
  if (
    r.source_generation !== s.source_generation ||
    r.facts_hash !== s.facts_hash
  )
    throw new GradingError('SNAPSHOT_STALE', 409);
  if (row.status !== 'approved') requireStaff(ctx);
  return { ...r, status: row.status as Report['status'] };
}
export function approveReport(
  ctx: PageContext,
  id: string,
  expectedRevision: number,
  expectedGeneration: number,
  hash: string,
) {
  requireStaff(ctx);
  return transaction(ctx.db, () => {
    const report = readReport(ctx, id),
      s = readSnapshot(ctx, report.snapshot_id);
    if (report.revision !== expectedRevision)
      throw new GradingError('REVISION_MISMATCH', 412);
    if (s.source_generation !== expectedGeneration || s.facts_hash !== hash)
      throw new GradingError('SNAPSHOT_STALE', 409);
    if (report.rendered_text !== renderObservations(s, report.observations))
      throw new GradingError('REPORT_EVIDENCE_MISMATCH');
    if (
      !ctx.db
        .prepare(
          "UPDATE grading_v3_reports SET status='approved' WHERE id=? AND tenant=? AND generation=? AND revision=? AND status IN ('draft','approved')",
        )
        .run(id, ctx.actor.academyId, expectedGeneration, expectedRevision)
        .changes
    )
      throw new GradingError('SNAPSHOT_STALE', 409);
    return { ...report, status: 'approved' as const };
  });
}
