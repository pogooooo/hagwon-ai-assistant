import { randomUUID, createHash } from 'node:crypto';
import { neisText, type NeisResult, type NeisRow } from './neis.ts';
import { dateInput, requireAdmin } from './knowledge.ts';
import type { OperationsDatabase } from './database.ts';
import type { SourceDocumentInput } from '../rag-consultation/server/types.ts';
import type { RagConfig } from '../rag-consultation/server/config.ts';
import type { MakeupSuggestion } from '../makeup-schedule/model/types.ts';
import { accessibleClasses, accessibleStudents } from './directory.ts';
import {
  escapeHtml as h,
  field,
  required,
  one,
  rows,
  transaction,
  OperationError,
  type PageContext,
  type OperationModule,
} from './shared.ts';

interface School {
  id: string;
  name: string;
  office: string;
  code: string;
}
export interface SchoolExam {
  id: string;
  academy_id: string;
  school_id: string;
  name: string;
  start: string;
  end: string;
  grades: string;
  state: string;
  source: string;
  fetched_at: string;
  confirmed_at: string | null;
  version: number;
}
export function setupSchools(db: OperationsDatabase) {
  db.exec(`CREATE TABLE IF NOT EXISTS op_schools(id TEXT NOT NULL,academy_id TEXT NOT NULL,name TEXT NOT NULL,office TEXT NOT NULL,code TEXT NOT NULL,PRIMARY KEY(academy_id,id));
    CREATE TABLE IF NOT EXISTS op_school_search(id TEXT PRIMARY KEY,academy_id TEXT NOT NULL,actor_id TEXT NOT NULL,result TEXT NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS op_class_schools(academy_id TEXT NOT NULL,class_id TEXT NOT NULL,school_id TEXT NOT NULL,grade INTEGER NOT NULL,PRIMARY KEY(academy_id,class_id,school_id,grade));
    CREATE TABLE IF NOT EXISTS op_school_exams(id TEXT PRIMARY KEY,academy_id TEXT NOT NULL,school_id TEXT NOT NULL,name TEXT NOT NULL,start TEXT NOT NULL,end TEXT NOT NULL,grades TEXT NOT NULL,state TEXT NOT NULL,source TEXT NOT NULL,fetched_at TEXT NOT NULL,confirmed_at TEXT,version INTEGER NOT NULL DEFAULT 1);
    CREATE INDEX IF NOT EXISTS op_school_exam_scope ON op_school_exams(academy_id,state,school_id,start,end);`);
}
export function isExamCandidate(name: string) {
  return /고사|시험|평가/.test(name);
}
export function eventGrades(row: NeisRow) {
  return ['ONE', 'TW', 'THREE', 'FR', 'FIV', 'SIX'].flatMap((name, i) =>
    neisText(row, name + '_GRADE_EVENT_YN') === 'Y' ? [i + 1] : [],
  );
}
function school(ctx: PageContext, id: string) {
  const result = one<School>(
    ctx.db,
    'SELECT * FROM op_schools WHERE academy_id=? AND id=?',
    ctx.actor.academyId,
    id,
  );
  if (!result) throw new OperationError('등록한 학교를 선택해 주세요.', 404);
  return result;
}
export function classExams(
  db: OperationsDatabase,
  academyId: string,
  classId: string,
): SchoolExam[] {
  const mappings = rows<{ school_id: string; grade: number }>(
    db,
    'SELECT school_id,grade FROM op_class_schools WHERE academy_id=? AND class_id=?',
    academyId,
    classId,
  );
  return rows<SchoolExam>(
    db,
    "SELECT * FROM op_school_exams WHERE academy_id=? AND state='approved' ORDER BY start,id",
    academyId,
  ).filter((e) =>
    mappings.some(
      (m) =>
        m.school_id === e.school_id &&
        (JSON.parse(e.grades) as number[]).includes(m.grade),
    ),
  );
}
export function rankSchoolSuggestions<T extends MakeupSuggestion>(
  suggestions: T[],
  exams: SchoolExam[],
  canceledOn: string,
) {
  const close = exams.filter(
    (e) =>
      e.start >= canceledOn &&
      Date.parse(e.start) - Date.parse(canceledOn) <= 14 * 86400000,
  );
  return suggestions
    .map((suggestion, index) => {
      const clashes = exams.filter(
        (e) => e.start <= suggestion.slot.date && suggestion.slot.date <= e.end,
      );
      return {
        ...suggestion,
        examConflicts: clashes.map((e) => `${e.name} (${e.start}~${e.end})`),
        beforeExam: close.some((e) => suggestion.slot.date < e.start),
        index,
      };
    })
    .sort(
      (a, b) =>
        Number(a.examConflicts.length > 0) -
          Number(b.examConflicts.length > 0) ||
        Number(b.beforeExam) - Number(a.beforeExam) ||
        a.index - b.index,
    );
}
const schoolDocumentId = (
  classId: string,
  schoolId: string,
  grade: number,
  event: Pick<SchoolExam, 'name' | 'start'>,
) =>
  'school-' +
  createHash('sha256')
    .update(
      JSON.stringify([
        classId,
        schoolId,
        grade,
        event.name,
        event.start.slice(0, 7),
      ]),
    )
    .digest('hex');
const markdownCell = (value: string) =>
  value.replace(/\|/g, '／').replace(/[\r\n]+/g, ' ');
export function schoolEvidence(
  db: OperationsDatabase,
  academyId: string,
): SourceDocumentInput[] {
  const classes = rows<{ id: string; name: string }>(
    db,
    'SELECT id,name FROM classes WHERE academy_id=?',
    academyId,
  );
  const mappings = rows<{ class_id: string; school_id: string; grade: number }>(
    db,
    'SELECT * FROM op_class_schools WHERE academy_id=?',
    academyId,
  );
  const approved = rows<SchoolExam>(
    db,
    "SELECT * FROM op_school_exams WHERE academy_id=? AND state='approved' ORDER BY start,id",
    academyId,
  );
  return mappings.flatMap((mapping) => {
    const klass = classes.find((c) => c.id === mapping.class_id),
      school = one<School>(
        db,
        'SELECT * FROM op_schools WHERE academy_id=? AND id=?',
        academyId,
        mapping.school_id,
      );
    if (!klass || !school) return [];
    const groups = new Map<string, SchoolExam[]>();
    for (const e of approved.filter(
      (e) =>
        e.school_id === school.id &&
        (JSON.parse(e.grades) as number[]).includes(mapping.grade),
    )) {
      const id = schoolDocumentId(klass.id, school.id, mapping.grade, e);
      groups.set(id, [...(groups.get(id) ?? []), e]);
    }
    return [...groups].map(([documentId, events]) => {
      const confirmed = events.map((e) => e.confirmed_at!).sort(),
        date = confirmed.at(-1)!.slice(0, 10);
      const revision =
        parseInt(
          createHash('sha256')
            .update(JSON.stringify(events))
            .digest('hex')
            .slice(0, 7),
          16,
        ) + 1;
      const title = `${school.name} ${mapping.grade}학년 ${events[0].name} · 학교 공개 학사일정 기준 · 확인 ${date} · 학교 공지가 우선`;
      return {
        academyId,
        documentId,
        revision,
        documentType: 'announcement' as const,
        title,
        text:
          `## ${klass.name} ${school.name} ${mapping.grade}학년 ${events[0].name} 시험 일정\n| 반 | 학교 | 학년 | 시험 일정 |\n| --- | --- | --- | --- |\n` +
          events
            .map(
              (e) =>
                `| ${[klass.name, school.name, mapping.grade + '학년', e.name + ' ' + e.start + (e.end === e.start ? '' : ' ~ ' + e.end)].map(markdownCell).join(' | ')} |`,
            )
            .join('\n') +
          `\n\n학교 공개 학사일정 기준, 확인한 날짜 ${date}, 학교 공지가 우선입니다.`,
        visibility: 'class_members' as const,
        classId: klass.id,
        validFrom: confirmed[0],
        approvedAt: confirmed.at(-1)!,
      };
    });
  });
}
/** Resolve the operational school/grade catalog before querying the unchanged RAG engine. */
export function schoolQuerySelection(
  ctx: PageContext,
  question: string,
  studentId = '',
):
  | {
      documents: SourceDocumentInput[];
      config: Partial<RagConfig>;
      clarify?: string[];
    }
  | undefined {
  if (
    !/시험|고사|평가/.test(question) ||
    !/언제|날짜|일정|기간/.test(question) ||
    /범위|점수|성적|비교|(?:말고|제외)(?:\s|[,.?!]|$)|그리고|또는|보강|휴강/.test(
      question,
    )
  )
    return;
  const selection = (documents: SourceDocumentInput[]) => ({
    documents,
    config: {
      topics: [
        {
          id: 'school_exam_calendar',
          label: '학교 시험 일정',
          kind: 'section' as const,
          terms: [question],
          evidenceTerms: ['시험 일정'],
          factTypes: [],
        },
      ],
    },
  });
  const students = accessibleStudents(ctx.db, ctx.actor);
  const selected = studentId
    ? students.find((s) => s.id === studentId)
    : undefined;
  if (studentId && !selected) return selection([]);
  const classes = accessibleClasses(ctx.db, ctx.actor).filter(
    (c) => !selected || selected.classIds.includes(c.id),
  );
  const mentioned = classes.filter((c) =>
    question.replace(/\s/g, '').includes(c.name.replace(/\s/g, '')),
  );
  const unbound = classes.reduce((q, c) => q.replaceAll(c.name, ''), question);
  if (/수학|영어|국어|과학|사회|준비물|비용|금액/.test(unbound))
    return selection([]);
  const schools = rows<School>(
    ctx.db,
    'SELECT * FROM op_schools WHERE academy_id=?',
    ctx.actor.academyId,
  );
  const names = [
    ...question.matchAll(/[가-힣]+(?:초등학교|중학교|고등학교)/g),
  ].map((m) => m[0]);
  if (names.some((name) => !schools.some((s) => s.name === name)))
    return selection([]);
  const grades = [...question.matchAll(/([1-6])\s*학년/g)].map((m) =>
    Number(m[1]),
  );
  if (new Set(grades).size > 1) return selection([]);
  const scope = mentioned.length ? mentioned : classes;
  const mappings = rows<{ class_id: string; school_id: string; grade: number }>(
    ctx.db,
    'SELECT * FROM op_class_schools WHERE academy_id=?',
    ctx.actor.academyId,
  ).filter(
    (m) =>
      scope.some((c) => c.id === m.class_id) &&
      (!names.length ||
        names.includes(
          schools.find((s) => s.id === m.school_id)?.name ?? '',
        )) &&
      (!grades.length || grades.includes(m.grade)),
  );
  if (new Set(mappings.map((m) => m.school_id + ':' + m.grade)).size !== 1)
    return selection([]);
  const term = /기말|중간/.exec(question)?.[0];
  const today = new Date(Date.now() + 32400000).toISOString().slice(0, 10);
  const months = [...question.matchAll(/(\d{1,2})\s*월/g)].map((m) =>
    Number(m[1]),
  );
  const years = [...question.matchAll(/(20\d{2})\s*년/g)].map((m) => m[1]);
  if (
    new Set(months).size > 1 ||
    new Set(years).size > 1 ||
    months.some((m) => m < 1 || m > 12) ||
    /이번\s*주|다음\s*주|지난\s*주|오늘|내일|모레|\d+\s*일/.test(question)
  )
    return selection([]);
  const relativeMonth = /이번\s*달|다음\s*달|지난\s*달/
    .exec(question)?.[0]
    .replace(/\s/g, '');
  const relativeDate = new Date(
    Date.UTC(
      Number(today.slice(0, 4)),
      Number(today.slice(5, 7)) -
        1 +
        (relativeMonth === '다음달' ? 1 : relativeMonth === '지난달' ? -1 : 0),
      1,
    ),
  );
  const month =
    months[0] ?? (relativeMonth ? relativeDate.getUTCMonth() + 1 : undefined);
  const relativeYear = /내년|올해|작년/.exec(question)?.[0];
  const year =
    years[0] ??
    (relativeYear
      ? String(
          Number(today.slice(0, 4)) +
            (relativeYear === '내년' ? 1 : relativeYear === '작년' ? -1 : 0),
        )
      : relativeMonth
        ? String(relativeDate.getUTCFullYear())
        : undefined);
  const exams = rows<SchoolExam>(
    ctx.db,
    "SELECT * FROM op_school_exams WHERE academy_id=? AND state='approved'",
    ctx.actor.academyId,
  ).filter(
    (e) =>
      mappings.some(
        (m) =>
          m.school_id === e.school_id &&
          (JSON.parse(e.grades) as number[]).includes(m.grade),
      ) &&
      (!term || e.name.includes(term)) &&
      (!month || Number(e.start.slice(5, 7)) === Number(month)) &&
      (!year || e.start.startsWith(year)) &&
      (month || year || /지난/.test(question) || e.end >= today),
  );
  if (!exams.length) return selection([]);
  const cycles = [
    ...new Set(exams.map((e) => e.name + '\0' + e.start.slice(0, 7))),
  ];
  // A year can contain multiple exams with the same name. Never let retrieval
  // silently choose one when the caller has not identified the intended period.
  if (cycles.length > 1) {
    const mapping = mappings[0],
      schoolName = schools.find((s) => s.id === mapping.school_id)!.name;
    return {
      ...selection([]),
      clarify: cycles.map((cycle) => {
        const [name, month] = cycle.split('\0');
        return `${schoolName} ${mapping.grade}학년 ${month.slice(0, 4)}년 ${Number(month.slice(5, 7))}월 ${name} 날짜 알려주세요.`;
      }),
    };
  }
  const documents = schoolEvidence(ctx.db, ctx.actor.academyId).filter(
    (d) =>
      mappings.some((m) => d.classId === m.class_id) &&
      exams.some((e) =>
        mappings.some(
          (m) =>
            m.class_id === d.classId &&
            d.documentId ===
              schoolDocumentId(m.class_id, m.school_id, m.grade, e),
        ),
      ),
  );
  return selection(documents);
}
export const schoolsModule: OperationModule = {
  path: '/schools',
  label: '학교 시험 일정',
  roles: ['admin'],
  setup: setupSchools,
  render(ctx) {
    requireAdmin(ctx);
    const schools = rows<School>(
      ctx.db,
      'SELECT * FROM op_schools WHERE academy_id=? ORDER BY name',
      ctx.actor.academyId,
    );
    const options = schools
      .map((s) => `<option value="${h(s.id)}">${h(s.name)}</option>`)
      .join('');
    const exams = rows<SchoolExam>(
      ctx.db,
      'SELECT * FROM op_school_exams WHERE academy_id=? ORDER BY start DESC',
      ctx.actor.academyId,
    );
    const saved = one<{ result: string }>(
      ctx.db,
      'SELECT result FROM op_school_search WHERE id=? AND academy_id=? AND actor_id=? AND expires_at>?',
      ctx.url.searchParams.get('search') ?? '',
      ctx.actor.academyId,
      ctx.actor.id,
      Date.now(),
    );
    const result: NeisResult | undefined = saved
      ? JSON.parse(saved.result)
      : undefined;
    const mappings = rows<{
      class_id: string;
      school_id: string;
      grade: number;
    }>(
      ctx.db,
      'SELECT * FROM op_class_schools WHERE academy_id=?',
      ctx.actor.academyId,
    );
    const classes = accessibleClasses(ctx.db, ctx.actor);
    return `<div class="page-heading"><h1>학교 시험 일정</h1><p>가져온 행사는 시험 후보입니다. 학교·학년·날짜를 확인해 승인해 주세요.</p></div><section class="panel"><h2>학교 찾기</h2><form method="post"><div class="fields"><label>교육청 코드<input name="office" value="N10" maxlength="3" required></label><label>학교 이름<input name="name" maxlength="100" required></label></div><button name="action" value="search">검색</button></form>${result ? `<p>${result.rows.length} / ${result.total}건 ${result.complete ? '' : '· 일부 결과'}</p>${result.rows.map((r, i) => `<form method="post"><input type="hidden" name="search" value="${h(ctx.url.searchParams.get('search'))}"><input type="hidden" name="index" value="${i}"><p>${h(neisText(r, 'SCHUL_NM'))} · ${h(neisText(r, 'ORG_RDNMA'))} <button name="action" value="select">학교 등록</button></p></form>`).join('')}` : ''}</section>
    ${
      schools.length
        ? `<section class="panel"><h2>학기 일정 가져오기</h2><form method="post"><label>학교<select name="schoolId">${options}</select></label><div class="fields"><label>학기 시작<input name="from" type="date" required></label><label>학기 종료<input name="until" type="date" required></label></div><button name="action" value="import">학사일정 가져오기</button></form>${ctx.url.searchParams.has('imported') ? `<p role="status">시험 후보 ${h(ctx.url.searchParams.get('imported'))}건. ${ctx.url.searchParams.get('complete') === '1' ? '요청 기간 조회 완료' : '일부 결과입니다. 전체 학기 확인에는 나이스 인증키가 필요합니다.'}</p>` : ''}</section>
    <section class="panel"><h2>반과 학교·학년 연결</h2><ul>${mappings.map((m) => `<li>${h(classes.find((c) => c.id === m.class_id)?.name)} · ${h(schools.find((s) => s.id === m.school_id)?.name)} ${m.grade}학년<form method="post"><input type="hidden" name="classId" value="${h(m.class_id)}"><input type="hidden" name="schoolId" value="${h(m.school_id)}"><input type="hidden" name="grade" value="${m.grade}"><button name="action" value="unlink" class="secondary">연결 해제</button></form></li>`).join('')}</ul><form method="post"><div class="fields"><label>반<select name="classId">${classes.map((c) => `<option value="${h(c.id)}">${h(c.name)}</option>`).join('')}</select></label><label>학교<select name="schoolId">${options}</select></label><label>학년<input type="number" name="grade" min="1" max="6" required></label></div><button name="action" value="link">연결</button></form></section>
    <details class="panel"><summary>학교 시험 직접 입력</summary><form method="post"><label>학교<select name="schoolId">${options}</select></label><label>시험명<input name="name" maxlength="100" required></label><div class="fields"><label>시작일<input name="from" type="date" required></label><label>종료일<input name="until" type="date" required></label><label>학년 (예: 1,2,3)<input name="grades" required></label></div><label>학교 공지 출처 (HTTPS)<input name="source" type="url" required></label><button name="action" value="manual">확인 대기로 저장</button></form></details>`
        : ''
    }
    ${exams.map((e) => `<section class="panel"><h2>${h(schools.find((s) => s.id === e.school_id)?.name)} · ${h(e.name)}</h2><p>${h(e.start)} ~ ${h(e.end)} · ${h((JSON.parse(e.grades) as number[]).join('·') || '학년 확인 필요')}학년 · ${h(e.state === 'approved' ? '확인 완료' : e.state === 'draft' ? '확인 대기' : '철회')}</p><p class="muted">${h(e.source)} · 가져온 날짜 ${h(e.fetched_at.slice(0, 10))}</p><form method="post"><input type="hidden" name="id" value="${h(e.id)}"><input type="hidden" name="version" value="${e.version}">${e.state === 'draft' ? `<label>적용 학년<input name="grades" value="${h((JSON.parse(e.grades) as number[]).join(','))}" required></label><button name="action" value="approve">날짜·학년 확인 후 승인</button>` : e.state === 'approved' ? '<button name="action" value="revoke" class="secondary">철회</button>' : ''}</form></section>`).join('')}`;
  },
  async submit(ctx, form) {
    requireAdmin(ctx);
    const action = field(form, 'action');
    if (action === 'search') {
      const office = required(form, 'office', '교육청', 3);
      if (!/^[A-Z]\d{2}$/.test(office))
        throw new OperationError('교육청 코드를 확인해 주세요.');
      const result = await ctx.services!.neis.query('schoolInfo', {
        ATPT_OFCDC_SC_CODE: office,
        SCHUL_NM: required(form, 'name', '학교 이름', 100),
      });
      requireAdmin(ctx);
      const id = randomUUID();
      ctx.db
        .prepare('DELETE FROM op_school_search WHERE expires_at<=?')
        .run(Date.now());
      ctx.db
        .prepare('INSERT INTO op_school_search VALUES(?,?,?,?,?)')
        .run(
          id,
          ctx.actor.academyId,
          ctx.actor.id,
          JSON.stringify(result),
          Date.now() + 900000,
        );
      return '/schools?search=' + id;
    }
    if (action === 'select') {
      const saved = one<{ result: string }>(
        ctx.db,
        'SELECT result FROM op_school_search WHERE id=? AND academy_id=? AND actor_id=? AND expires_at>?',
        field(form, 'search'),
        ctx.actor.academyId,
        ctx.actor.id,
        Date.now(),
      );
      const result: NeisResult | undefined = saved
        ? JSON.parse(saved.result)
        : undefined;
      const i = Number(field(form, 'index')),
        r = Number.isInteger(i) ? result?.rows[i] : undefined;
      if (!r || !neisText(r, 'SD_SCHUL_CODE'))
        throw new OperationError('학교를 다시 검색해 주세요.', 409);
      ctx.db
        .prepare('INSERT OR IGNORE INTO op_schools VALUES(?,?,?,?,?)')
        .run(
          neisText(r, 'ATPT_OFCDC_SC_CODE') +
            ':' +
            neisText(r, 'SD_SCHUL_CODE'),
          ctx.actor.academyId,
          neisText(r, 'SCHUL_NM'),
          neisText(r, 'ATPT_OFCDC_SC_CODE'),
          neisText(r, 'SD_SCHUL_CODE'),
        );
      return;
    }
    if (action === 'link' || action === 'unlink') {
      const s = school(ctx, field(form, 'schoolId')),
        classId = field(form, 'classId'),
        grade = Number(field(form, 'grade'));
      if (
        !accessibleClasses(ctx.db, ctx.actor).some((c) => c.id === classId) ||
        !Number.isInteger(grade) ||
        grade < 1 ||
        grade > 6
      )
        throw new OperationError('반·학년을 확인해 주세요.');
      if (action === 'link')
        ctx.db
          .prepare('INSERT OR IGNORE INTO op_class_schools VALUES(?,?,?,?)')
          .run(ctx.actor.academyId, classId, s.id, grade);
      else
        ctx.db
          .prepare(
            'DELETE FROM op_class_schools WHERE academy_id=? AND class_id=? AND school_id=? AND grade=?',
          )
          .run(ctx.actor.academyId, classId, s.id, grade);
      return;
    }
    if (action === 'import' || action === 'manual') {
      const s = school(ctx, field(form, 'schoolId'));
      const from = dateInput(required(form, 'from', '시작일'), '시작일'),
        until = dateInput(required(form, 'until', '종료일'), '종료일');
      if (from > until || Date.parse(until) - Date.parse(from) > 200 * 86400000)
        throw new OperationError('200일 이내의 학기 기간을 선택해 주세요.');
      const result =
        action === 'import'
          ? await ctx.services!.neis.query('SchoolSchedule', {
              ATPT_OFCDC_SC_CODE: s.office,
              SD_SCHUL_CODE: s.code,
              AA_FROM_YMD: from.replaceAll('-', ''),
              AA_TO_YMD: until.replaceAll('-', ''),
            })
          : undefined;
      requireAdmin(ctx);
      const manualSource = field(form, 'source', 500);
      if (!result && !/^https:\/\/[^\s]+$/.test(manualSource))
        throw new OperationError('학교 공지 HTTPS 주소를 입력해 주세요.');
      const candidates = result
        ? result.rows
            .filter(
              (r) =>
                neisText(r, 'SD_SCHUL_CODE') === s.code &&
                isExamCandidate(neisText(r, 'EVENT_NM')),
            )
            .map((r) => ({
              name: neisText(r, 'EVENT_NM'),
              start: neisText(r, 'AA_YMD').replace(
                /^(\d{4})(\d{2})(\d{2})$/,
                '$1-$2-$3',
              ),
              end: neisText(r, 'AA_YMD').replace(
                /^(\d{4})(\d{2})(\d{2})$/,
                '$1-$2-$3',
              ),
              grades: eventGrades(r),
            }))
        : [
            {
              name: required(form, 'name', '시험명', 100),
              start: from,
              end: until,
              grades: parseGrades(field(form, 'grades')),
            },
          ];
      transaction(ctx.db, () => {
        for (const e of candidates) {
          dateInput(e.start, '시험일');
          if (e.start < from || e.end > until)
            throw new OperationError('조회 기간 밖 학사일정입니다.', 503);
          const id = createHash('sha256')
            .update(JSON.stringify([ctx.actor.academyId, s.id, e]))
            .digest('hex');
          ctx.db
            .prepare(
              'INSERT OR IGNORE INTO op_school_exams(id,academy_id,school_id,name,start,end,grades,state,source,fetched_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
            )
            .run(
              id,
              ctx.actor.academyId,
              s.id,
              e.name,
              e.start,
              e.end,
              JSON.stringify(e.grades),
              'draft',
              result?.source ?? manualSource,
              result?.fetchedAt ?? new Date().toISOString(),
            );
        }
      });
      return (
        '/schools?imported=' +
        candidates.length +
        '&complete=' +
        (result?.complete || !result ? '1' : '0')
      );
    }
    if (action === 'approve' || action === 'revoke') {
      const grades =
        action === 'approve'
          ? parseGrades(required(form, 'grades', '학년'))
          : [];
      const updated = ctx.db
        .prepare(
          `UPDATE op_school_exams SET state=?,grades=CASE WHEN ?='approve' THEN ? ELSE grades END,confirmed_at=?,version=version+1 WHERE id=? AND academy_id=? AND version=? AND state=?`,
        )
        .run(
          action === 'approve' ? 'approved' : 'revoked',
          action,
          JSON.stringify(grades),
          new Date().toISOString(),
          field(form, 'id'),
          ctx.actor.academyId,
          Number(field(form, 'version')),
          action === 'approve' ? 'draft' : 'approved',
        );
      if (!updated.changes)
        throw new OperationError(
          '일정이 변경되었습니다. 다시 확인해 주세요.',
          409,
        );
      return;
    }
    throw new OperationError('지원하지 않는 작업입니다.');
  },
};
function parseGrades(value: string) {
  const grades = [
    ...new Set(value.split(',').map((v) => Number(v.trim()))),
  ].sort();
  if (
    !grades.length ||
    grades.some((g) => !Number.isInteger(g) || g < 1 || g > 6)
  )
    throw new OperationError('학년은 1~6을 쉼표로 구분해 주세요.');
  return grades;
}
