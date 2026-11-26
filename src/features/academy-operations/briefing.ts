import { workbookAnalytics } from './workbook-results.ts';
import { workbookReportReason } from './learning.ts';
import { accessibleClasses, accessibleStudents } from './directory.ts';
import {
  analyze,
  parseClassification,
  tagById,
  type Classification,
  type Outcome,
} from './classification.ts';
import {
  escapeHtml as h,
  one,
  OperationError,
  rows,
  type OperationModule,
  type PageContext,
} from './shared.ts';

/** 확정: 최신 분류에 맞춰 검수가 끝난 결과. 브리핑 집계에는 확정 결과만 쓴다. */
export type BriefingState =
  'confirmed' | 'reported' | 'draft' | 'stale' | 'withdrawn' | 'missing';

export interface BriefingEntry {
  studentId: string;
  name: string;
  state: BriefingState;
  outcomes: Record<string, Outcome>;
}

interface Rate {
  correct: number;
  total: number;
}
interface TypeRate extends Rate {
  tagId: string;
  name: string;
  area: string;
  referenceOnly: boolean;
}
interface ItemLabel {
  itemId: string;
  page: number;
  displayNumber: string;
  label: string;
}

export interface Briefing {
  stateCounts: Record<BriefingState, number>;
  overall: Rate;
  unclassified: number;
  areas: ({ name: string } & Rate)[];
  types: TypeRate[];
  reteach: TypeRate[];
  missedItems: (ItemLabel & { incorrect: number; checked: number })[];
  students: (Omit<BriefingEntry, 'outcomes'> &
    Rate & {
      unknown: number;
      wrongItems: ItemLabel[];
      weakTypes: TypeRate[];
    })[];
}

const itemLabel = (item: Classification['items'][number]) =>
  item.reviewedType ||
  (item.itemStatus === 'classified'
    ? item.tags
        .filter((t) => t.status === 'adopted')
        .map((t) => tagById.get(t.tagId)!.name)
        .join(', ')
    : {
        no_adopted: '채택 태그 없음',
        unreadable: '읽기 불가',
        out_of_scope: '분류 범위 밖',
      }[item.itemStatus]);

// 정답률이 낮은 순, 동률은 태그 ID 순. 오답이 없는 유형은 다시 설명할 대상이 아니다.
const weakest = (types: TypeRate[]) =>
  types
    .filter((t) => t.correct < t.total)
    .sort(
      (a, b) =>
        a.correct / a.total - b.correct / b.total ||
        a.tagId.localeCompare(b.tagId),
    );

/** 한 숙제의 반 전체 요약. 학습 기록과 같은 기준(채택 태그·확인된 문항)으로만 센다. */
export function summarizeBriefing(
  classification: Classification,
  entries: BriefingEntry[],
): Briefing {
  const stateCounts: Briefing['stateCounts'] = {
    confirmed: 0,
    reported: 0,
    draft: 0,
    stale: 0,
    withdrawn: 0,
    missing: 0,
  };
  const overall = { correct: 0, total: 0 };
  const areas = new Map<string, { name: string } & Rate>();
  const types = new Map<string, TypeRate>();
  const missed = new Map(
    classification.items.map((item) => [
      item.itemId,
      { incorrect: 0, checked: 0 },
    ]),
  );
  const students = entries.map(({ outcomes, ...entry }) => {
    stateCounts[entry.state]++;
    if (entry.state !== 'confirmed' && entry.state !== 'reported')
      return {
        ...entry,
        correct: 0,
        total: 0,
        unknown: 0,
        wrongItems: [],
        weakTypes: [],
      };
    const summary = analyze(classification, outcomes);
    const workbook = classification.items.every((i) => i.book);
    const correct = workbook
      ? classification.items.filter((i) => outcomes[i.itemId] === 'correct')
          .length
      : summary.correct;
    const total = workbook
      ? correct +
        classification.items.filter((i) => outcomes[i.itemId] === 'incorrect')
          .length
      : summary.assessed;
    overall.correct += correct;
    overall.total += total;
    for (const area of summary.areas) {
      const row = areas.get(area.name) ?? {
        name: area.name,
        correct: 0,
        total: 0,
      };
      row.correct += area.correct;
      row.total += area.total;
      areas.set(area.name, row);
    }
    const own: TypeRate[] = summary.tags.map(
      ({ tagId, name, area, referenceOnly, correct, total }) => ({
        tagId,
        name,
        area,
        referenceOnly,
        correct,
        total,
      }),
    );
    for (const tag of own) {
      const row = types.get(tag.tagId) ?? { ...tag, correct: 0, total: 0 };
      row.correct += tag.correct;
      row.total += tag.total;
      types.set(tag.tagId, row);
    }
    const wrongItems: ItemLabel[] = [];
    for (const item of classification.items) {
      const outcome = Object.hasOwn(outcomes, item.itemId)
        ? outcomes[item.itemId]
        : 'unknown';
      if (outcome === 'unknown') continue;
      const row = missed.get(item.itemId)!;
      row.checked++;
      if (outcome !== 'incorrect') continue;
      row.incorrect++;
      wrongItems.push({
        itemId: item.itemId,
        page: item.page,
        displayNumber: [item.book, item.segment, item.displayNumber]
          .filter(Boolean)
          .join(' · '),
        label: itemLabel(item),
      });
    }
    return {
      ...entry,
      correct,
      total,
      unknown: summary.unknown,
      wrongItems,
      weakTypes: weakest(own),
    };
  });
  const allTypes = [...types.values()].sort((a, b) =>
    a.tagId.localeCompare(b.tagId),
  );
  return {
    stateCounts,
    overall,
    unclassified: classification.items.filter(
      (item) => item.itemStatus !== 'classified',
    ).length,
    areas: [...areas.values()].sort((a, b) => a.name.localeCompare(b.name)),
    types: allTypes,
    reteach: weakest(allTypes).slice(0, 3),
    missedItems: classification.items
      .map((item) => ({
        itemId: item.itemId,
        page: item.page,
        displayNumber: [item.book, item.segment, item.displayNumber]
          .filter(Boolean)
          .join(' · '),
        label: itemLabel(item),
        ...missed.get(item.itemId)!,
      }))
      .filter((item) => item.incorrect > 0)
      .sort(
        (a, b) =>
          b.incorrect / b.checked - a.incorrect / a.checked ||
          b.incorrect - a.incorrect,
      )
      .slice(0, 5),
    students,
  };
}

interface AssignmentRow {
  assignment_id: string;
  class_id: string;
  title: string;
  period: string;
  revision: number;
  classification: string;
}
interface ResultRow {
  student_id: string;
  reason: string;
  classification_revision: number;
  outcomes: string;
  state: 'draft' | 'confirmed' | 'withdrawn';
}

const stateLabels: Record<BriefingState, string> = {
  confirmed: '확정',
  reported: '학생 제출',
  draft: '검수 대기',
  stale: '재검수 필요',
  withdrawn: '철회됨',
  missing: '결과 없음',
};
const percent = ({ correct, total }: Rate) =>
  total ? ((100 * correct) / total).toFixed(1) + '%' : '집계 없음';
const metric = (label: string, rate: Rate, note?: string) =>
  `<article class="metric-card"><small>${h(label)}</small><strong>${percent(rate)}</strong><p>${note ?? `${rate.total}건 중 ${rate.correct}건 정답`}</p><progress value="${rate.correct}" max="${rate.total || 1}"></progress></article>`;
const reference = (type: { referenceOnly: boolean }) =>
  type.referenceOnly ? ' <span class="pill">참고용</span>' : '';

function render(ctx: PageContext) {
  if (
    !ctx.url.searchParams.has('assignment') &&
    !ctx.url.searchParams.has('legacy') &&
    ctx.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='homework_workbooks'",
      )
      .get()
  ) {
    return (
      workbookAnalytics(ctx, false) +
      '<p><a href="/briefing?legacy=1">기존 학습 기록 브리핑</a></p>'
    );
  }
  const classes = accessibleClasses(ctx.db, ctx.actor);
  const assignments = rows<AssignmentRow>(
    ctx.db,
    'SELECT assignment_id, class_id, title, period, revision, classification FROM op_learning_assignments WHERE academy_id = ? ORDER BY period DESC, assignment_id',
    ctx.actor.academyId,
  ).filter((a) => classes.some((c) => c.id === a.class_id));
  const className = (id: string) => classes.find((c) => c.id === id)?.name;
  const list = `<section class="panel"><h2>숙제 목록</h2><ul class="item-list">${
    assignments
      .map(
        (a) =>
          `<li><a href="/briefing?assignment=${encodeURIComponent(a.assignment_id)}">${h(a.title)}</a><small>${h(className(a.class_id))} · ${h(a.period)}</small></li>`,
      )
      .join('') || '<li>등록된 분류 숙제가 없습니다.</li>'
  }</ul></section>`;
  const id = ctx.url.searchParams.get('assignment');
  const assignment = id
    ? assignments.find((a) => a.assignment_id === id)
    : assignments.length === 1
      ? assignments[0]
      : undefined;
  if (id && !assignment)
    throw new OperationError('조회 가능한 분류 숙제가 아닙니다.', 404);
  const heading =
    '<div class="page-heading"><h1>브리핑</h1><p>숙제 한 건의 반 전체 결과를 요약합니다. 교재 숙제는 학생이 제출한 오답을, 그 밖의 숙제는 검수 확정 결과를 집계합니다.</p></div>';
  if (!assignment)
    return `${heading}<div class="split learning-layout">${list}<section class="panel"><p>숙제를 선택해 반 전체 결과를 확인해 주세요.</p></section></div>`;

  const classification = parseClassification(
    JSON.parse(assignment.classification),
  );
  const entries: BriefingEntry[] = accessibleStudents(ctx.db, ctx.actor)
    .filter((s) => s.classIds.includes(assignment.class_id))
    .map((s) => {
      const result = one<ResultRow>(
        ctx.db,
        'SELECT student_id, classification_revision, outcomes, state, reason FROM op_learning_results WHERE academy_id = ? AND assignment_id = ? AND student_id = ? ORDER BY revision DESC LIMIT 1',
        ctx.actor.academyId,
        assignment.assignment_id,
        s.id,
      );
      const state: BriefingState = !result
        ? 'missing'
        : result.classification_revision !== assignment.revision
          ? 'stale'
          : result.state === 'draft' &&
              result.reason === workbookReportReason &&
              classification.items.every((i) => i.book)
            ? 'reported'
            : result.state;
      return {
        studentId: s.id,
        name: s.name,
        state,
        outcomes:
          state === 'confirmed' || state === 'reported'
            ? JSON.parse(result!.outcomes)
            : {},
      };
    });
  const briefing = summarizeBriefing(classification, entries);
  const counted =
    briefing.stateCounts.confirmed + briefing.stateCounts.reported;
  const waiting = (['draft', 'stale', 'withdrawn', 'missing'] as const)
    .filter((state) => briefing.stateCounts[state])
    .map((state) => `${stateLabels[state]} ${briefing.stateCounts[state]}명`)
    .join(' · ');
  const learningLink = (studentId: string) =>
    `/learning?assignment=${encodeURIComponent(assignment.assignment_id)}&amp;student=${encodeURIComponent(studentId)}`;

  const workbook = classification.items.every((i) => i.book);
  const countLabel = workbook ? '집계' : '확정';
  const summary = counted
    ? `<div class="learning-metrics">${metric('반 평균 정답률', briefing.overall, `${countLabel} ${counted}명 · ${briefing.overall.total}건 중 ${briefing.overall.correct}건 정답`)}${briefing.areas.map((a) => metric(a.name, a)).join('')}</div>
      <h3>한 번 더 설명할 유형</h3>${
        briefing.reteach.length
          ? `<div class="learning-metrics">${briefing.reteach.map((t) => metric(t.name + (t.referenceOnly ? ' (참고용)' : ''), t, `${h(t.area)} · ${t.total}건 중 ${t.correct}건 정답`)).join('')}</div>`
          : `<p class="muted">${briefing.types.length ? '분류된 유형에서는 오답이 없습니다.' : '채택된 유형이 있는 문항의 확인 결과가 없습니다.'}</p>`
      }
      <h3>많이 틀린 문항</h3>${
        briefing.missedItems.length
          ? `<div class="table-wrap"><table><thead><tr><th>쪽수</th><th>번호</th><th>오답 / 확인 학생</th><th>유형</th></tr></thead><tbody>${briefing.missedItems.map((i) => `<tr><td>${i.page}</td><td>${h(i.displayNumber)}</td><td>${i.incorrect} / ${i.checked}</td><td>${h(i.label)}</td></tr>`).join('')}</tbody></table></div>`
          : '<p class="muted">집계한 결과에 오답이 없습니다.</p>'
      }
      ${
        briefing.types.length
          ? `<details><summary>유형별 결과 전체 (${briefing.types.length}개)</summary><div class="table-wrap"><table><thead><tr><th>유형</th><th>영역</th><th>정답 / 확인</th><th>정답률</th></tr></thead><tbody>${briefing.types.map((t) => `<tr><td>${h(t.name)}${reference(t)}</td><td>${h(t.area)}</td><td>${t.correct} / ${t.total}</td><td>${percent(t)}</td></tr>`).join('')}</tbody></table></div></details>`
          : ''
      }`
    : `<p class="notice">${workbook ? '아직 학생이 제출한 결과가 없습니다.' : '아직 검수가 확정된 결과가 없습니다.'}</p>`;

  const cards = briefing.students
    .map((s) => {
      const body =
        s.state !== 'confirmed' && s.state !== 'reported'
          ? `<strong>—</strong><p>${stateLabels[s.state]}</p>`
          : `<strong>${percent(s)}</strong><p>${s.total}문항 중 ${s.correct}문항 정답${s.unknown ? ` · 미확인 ${s.unknown}문항` : ''}</p><progress value="${s.correct}" max="${s.total || 1}"></progress>${
              s.weakTypes.length
                ? `<p>약한 유형: ${h(s.weakTypes[0].name)}</p>`
                : ''
            }${
              s.wrongItems.length
                ? `<details><summary>오답 ${s.wrongItems.length}문항</summary><ul>${s.wrongItems.map((i) => `<li>${i.page}쪽 ${h(i.displayNumber)}번 · ${h(i.label)}</li>`).join('')}</ul>${s.weakTypes.length > 1 ? `<p>틀린 유형: ${s.weakTypes.map((t) => h(t.name)).join(', ')}</p>` : ''}</details>`
                : '<p>오답 없음</p>'
            }`;
      return `<article class="metric-card"><small>${h(s.name)} <span class="pill">${stateLabels[s.state]}</span></small>${body}<p><a href="${learningLink(s.studentId)}">학습 기록 열기</a></p></article>`;
    })
    .join('');

  return `${heading}<div class="split learning-layout">${list}
    <section class="panel"><div class="panel-heading"><h2>${h(assignment.title)}</h2><span class="pill">${h(className(assignment.class_id))} · ${h(assignment.period)}</span></div>
    <p class="muted">등록 ${classification.items.length}문항 · 분류 제외 ${briefing.unclassified}문항 · 대상 ${entries.length}명 중 집계 ${counted}명${waiting ? ' · ' + waiting : ''}</p>
    ${summary}
    <h3>학생별 결과</h3>${cards ? `<div class="learning-metrics">${cards}</div>` : '<p class="muted">이 반에 조회할 수 있는 원생이 없습니다.</p>'}
    </section></div>
    <p class="learning-caution">교재 숙제의 전체 정답률은 학생이 보고한 전체 문항을 기준으로 계산합니다. 유형별 정답률은 AI가 채택한 태그를 기준으로 계산합니다. 참고·보류 태그와 분류 제외 문항은 유형 집계에서 빠지며, 많이 틀린 문항에는 분류 제외 문항도 포함합니다. 수학 세부 유형은 참고용입니다. 이 요약만으로 실력·태도·원인을 단정하지 않습니다.</p>`;
}

export const briefingModule: OperationModule = {
  path: '/briefing',
  label: '브리핑',
  roles: ['admin', 'teacher'],
  setup() {},
  render: (ctx) =>
    `<p><a href="/student-reports">학생 분석·승인 리포트·교사용 상담 자료</a></p>` +
    render(ctx),
  submit() {
    throw new OperationError('브리핑은 조회 전용 화면입니다.', 405);
  },
};
