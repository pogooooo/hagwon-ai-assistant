import { randomUUID } from 'node:crypto';
import {
  parseSourceFile,
  detectFormat,
} from '../rag-consultation/server/ingest/parsers/index.ts';
import type { OperationsDatabase } from './database.ts';
import {
  editableQuestions,
  parseQuestions,
  selectQuestions,
  wantsVariants,
  type BankSource,
  type ExamItem,
} from './exam-questions.ts';
import {
  escapeHtml as h,
  field,
  one,
  rows,
  required,
  OperationError,
  type OperationModule,
  type PageContext,
} from './shared.ts';

const route = '/exam-builder';
type SourceRow = {
  id: string;
  title: string;
  subject: string;
  grade: string;
  topic: string;
  level: string;
  draft: string | null;
  questions: string;
};
type Paper = {
  id: string;
  request: string;
  items: string;
  revision: number;
  variant: number;
};
const scope = (ctx: PageContext) =>
  [ctx.actor.academyId, ctx.actor.id] as const;
function staff(ctx: PageContext) {
  ctx.assertCurrentAccess?.();
  if (!['admin', 'teacher'].includes(ctx.actor.role))
    throw new OperationError('교사 계정에서 이용할 수 있습니다.', 403);
}
function setup(db: OperationsDatabase) {
  db.exec(`
CREATE TABLE IF NOT EXISTS op_exam_sources(id TEXT PRIMARY KEY, academy TEXT NOT NULL, owner TEXT NOT NULL, title TEXT NOT NULL,subject TEXT NOT NULL,grade TEXT NOT NULL,topic TEXT NOT NULL,level TEXT NOT NULL,draft TEXT,questions TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS op_exam_source_owner ON op_exam_sources(academy,owner);
CREATE TABLE IF NOT EXISTS op_exam_papers(id TEXT PRIMARY KEY,academy TEXT NOT NULL,owner TEXT NOT NULL,request TEXT NOT NULL,variant INTEGER NOT NULL,items TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,request_key TEXT NOT NULL,UNIQUE(academy,owner,request_key));`);
}
function sourceRow(ctx: PageContext, id: string) {
  const row = one<SourceRow>(
    ctx.db,
    'SELECT * FROM op_exam_sources WHERE academy=? AND owner=? AND id=?',
    ...scope(ctx),
    id,
  );
  if (!row) throw new OperationError('자료를 찾을 수 없습니다.', 404);
  return row;
}
function sourceBank(ctx: PageContext): BankSource[] {
  return rows<SourceRow>(
    ctx.db,
    'SELECT id,title,subject,grade,topic,level,questions FROM op_exam_sources WHERE academy=? AND owner=? AND draft IS NULL',
    ...scope(ctx),
  ).map((row) => ({ ...row, questions: JSON.parse(row.questions) }));
}
function paperRow(ctx: PageContext, id: string) {
  const p = one<Paper>(
    ctx.db,
    'SELECT id,request,variant,items,revision FROM op_exam_papers WHERE academy=? AND owner=? AND id=?',
    ...scope(ctx),
    id,
  );
  if (!p) throw new OperationError('시험지를 찾을 수 없습니다.', 404);
  return p;
}
const formStart = (action: string) =>
  '<form method="post" action="' +
  route +
  '"><input type="hidden" name="action" value="' +
  action +
  '">';
const option = (values: string[]) =>
  values.map((v) => '<option>' + h(v) + '</option>').join('');
function buildForm(ctx: PageContext, request: string) {
  return `<section class="panel exam-form"><h2>시험지 만들기</h2>${formStart('build')}<input type="hidden" name="key" value="${randomUUID()}"><label>출제 요청<textarea name="request" rows="2" maxlength="400" required placeholder="중2 수학 일차함수 객관식 5문항 시험지 만들어줘">${h(request)}</textarea></label><p class="muted">학년·과목·단원·유형·문항 수를 조합할 수 있습니다. 개수를 생략하면 5문항을 고릅니다.</p>${ctx.services?.examVariants ? '<label class="check-label"><input type="checkbox" name="variant" value="yes">변형 출제 · 선택한 자작 문항과 정답을 네이버 CLOVA에 보내 새 문제 초안 만들기</label>' : ''}<button>시험지 만들기</button></form></section>`;
}
const input = (key: string, label: string, placeholder: string) =>
  `<label>${label}<input name="${key}" maxlength="80" placeholder="${placeholder}" required></label>`;
function uploadForm() {
  return `<section class="panel exam-form"><h2>자작 문제 파일 등록</h2><p><a class="exam-back" download href="/assets/ondap-exam-example.txt">중2 수학 · 일차함수 예제 파일 받기</a></p><form method="post" action="${route}" enctype="multipart/form-data"><input type="hidden" name="action" value="upload"><label>문제 파일<input name="file" type="file" required accept=".pdf,.docx,.hwpx,.txt,.md,.markdown"></label><p class="muted">텍스트 PDF, DOCX, HWPX, TXT, Markdown을 읽습니다. 인식한 문제와 보기는 저장 전에 수정할 수 있습니다.</p><div class="fields">${input('grade', '학년', '중2')}<label>과목<select name="subject">${option(['수학', '영어', '국어', '과학', '사회', '역사', '기타'])}</select></label>${input('topic', '단원 또는 주제', '일차함수')}<label>난이도<select name="level">${option(['기본', '기초', '심화'])}</select></label></div><button>문항 확인하기</button></form></section>`;
}
function list(ctx: PageContext, req: string) {
  const sources = rows<SourceRow>(
    ctx.db,
    'SELECT id,title,topic,grade,subject,level,draft IS NOT NULL AS draft FROM op_exam_sources WHERE academy=? AND owner=? ORDER BY rowid DESC',
    ...scope(ctx),
  );
  const papers = rows<Paper>(
    ctx.db,
    'SELECT id,request,variant FROM op_exam_papers WHERE academy=? AND owner=? ORDER BY rowid DESC',
    ...scope(ctx),
  );
  return `<div class="workspace-heading"><h1>시험지 제작</h1></div>${buildForm(ctx, req)}${uploadForm()}<section class="panel"><h2>내 문제 자료</h2>${sources.map((s) => `<a class="exam-row" href="${route}?source=${h(s.id)}"><strong>${h(s.title)}</strong><span>${h([s.grade, s.subject, s.topic, s.level].join(' · '))} · ${s.draft ? '검토 대기' : '등록됨'}</span></a>`).join('') || '<p>등록된 자료가 없습니다.</p>'}</section><section class="panel"><h2>만든 시험지</h2>${papers.map((p) => `<a class="exam-row" href="${route}?paper=${h(p.id)}">${h(p.request)} <span>${p.variant ? '변형 초안' : '기출 시험지'} ›</span></a>`).join('') || '<p>아직 만든 시험지가 없습니다.</p>'}</section>`;
}
function editForm(p: Paper, items: ExamItem[], submitted?: FormData) {
  return (
    '<details class="panel exam-form exam-screen-only"><summary>문항과 정답 수정</summary>' +
    formStart('edit') +
    '<input type="hidden" name="paper" value="' +
    h(p.id) +
    '"><input type="hidden" name="revision" value="' +
    h(submitted?.get('revision') ?? p.revision) +
    '">' +
    items
      .map(
        (item, i) =>
          '<fieldset><legend>' +
          (i + 1) +
          '번</legend><label>학생용 문항<textarea name="prompt" rows="3" maxlength="3500" required>' +
          h(submitted?.getAll('prompt')[i] ?? item.prompt) +
          '</textarea></label><label>교사용 정답<textarea name="answer" rows="2" maxlength="1500">' +
          h(submitted?.getAll('answer')[i] ?? item.answer) +
          '</textarea></label></fieldset>',
      )
      .join('') +
    '<button>수정 저장</button></form></details>'
  );
}
function render(ctx: PageContext) {
  staff(ctx);
  const id =
      ctx.url.searchParams.get('source') ??
      (ctx.submittedForm?.get('action') === 'approve'
        ? String(ctx.submittedForm.get('source'))
        : null),
    pid =
      ctx.url.searchParams.get('paper') ??
      (ctx.submittedForm?.get('action') === 'edit'
        ? String(ctx.submittedForm.get('paper'))
        : null);
  if (id) {
    const s = sourceRow(ctx, id);
    return `<a class="exam-back" href="${route}">← 시험지 제작</a><section class="panel exam-form"><h1>${h(s.title)}</h1>${s.draft === null ? '<p>등록된 ' + JSON.parse(s.questions).length + '문항</p><pre class="exam-text">' + h(editableQuestions(JSON.parse(s.questions))) + '</pre>' : `${formStart('approve')}<input type="hidden" name="source" value="${h(s.id)}"><label>문항과 정답 검토<textarea rows="14" name="text" maxlength="90000" required>${h(ctx.submittedForm?.get('text') ?? s.draft)}</textarea></label><p>각 문항은 ‘1. 문제’로 시작하고 보기는 ① ② 또는 (1) (2)로 입력합니다. 정답·해설은 다음 줄 ‘정답:’ 뒤에 둡니다. 표·그림·수식과 별도 정답표는 원본과 대조해 주세요.</p><label><input type="checkbox" name="checked" value="yes" required>문제와 정답이 구분됐고 학생에게 제공할 본문을 확인했습니다.</label><button>내 문제은행에 저장</button></form>`}</section>`;
  }
  if (pid) {
    const p = paperRow(ctx, pid),
      key =
        ctx.url.searchParams.get('sheet') === 'key' ||
        ctx.submittedForm?.get('action') === 'edit',
      items = JSON.parse(p.items) as ExamItem[];
    return `<div class="exam-toolbar"><a class="exam-back" href="${route}">← 시험지 제작</a><a class="button-link" href="${route}?paper=${h(pid)}${key ? '' : '&amp;sheet=key'}">${key ? '학생용 시험지' : '교사용 정답지'}</a><button type="button" data-print-exam>인쇄 · PDF 저장</button></div>${p.variant ? '<p class="notice exam-screen-only">AI 변형 초안입니다. 배부 전에 문제와 정답을 검토해 주세요.</p>' : ''}<article class="exam-sheet"><header><h1>${key ? '교사용 정답지' : '학습 시험지'}</h1><p>${key ? h(p.request) + ' · ' : ''}${items.length}문항</p>${key ? '' : '<p>이름 ____________________　 날짜 ______________</p>'}</header><ol>${items.map((it) => `<li><p class="preserve">${h(it.prompt)}</p>${key ? `<p class="preserve"><strong>정답</strong>　${h(it.answer || '원본에 등록된 정답 없음')}</p><small>출처 · ${h(it.sourceTitle)} · 등록 순서 ${it.number}번</small>` : ''}</li>`).join('')}</ol></article>${key ? editForm(p, items, ctx.submittedForm) : ''}`;
  }
  const req = String(
    ctx.submittedForm?.get('request') ??
      ctx.url.searchParams.get('request') ??
      '',
  ).slice(0, 400);
  let note = wantsVariants(req)
    ? '변형 문항을 만들려면 아래의 네이버 전송 항목을 선택해 주세요.'
    : '';
  if (ctx.url.searchParams.has('check')) {
    try {
      selectQuestions(req, sourceBank(ctx));
    } catch (e) {
      if (e instanceof OperationError) note = e.message;
      else throw e;
    }
  }
  return (
    (note ? '<p class="notice" role="alert">' + h(note) + '</p>' : '') +
    list(ctx, req)
  );
}

export async function buildExam(
  ctx: PageContext,
  request: string,
  key: string,
  consent: boolean,
) {
  staff(ctx);
  if (!request || request.length > 400 || !/^[-\w]{12,80}$/.test(key))
    throw new OperationError('출제 요청을 다시 입력해 주세요.');
  const variant = consent || wantsVariants(request);
  if (variant && !consent)
    return route + '?request=' + encodeURIComponent(request);
  const get = () =>
    one<{ id: string; request: string; variant: number }>(
      ctx.db,
      'SELECT id,request,variant FROM op_exam_papers WHERE academy=? AND owner=? AND request_key=?',
      ...scope(ctx),
      key,
    );
  const prior = get();
  if (prior) {
    if (prior.request !== request || Boolean(prior.variant) !== variant)
      throw new OperationError('이미 사용한 요청입니다.', 409);
    return route + '?paper=' + prior.id;
  }
  let items = selectQuestions(request, sourceBank(ctx), variant);
  if (variant) {
    if (!ctx.services?.examVariants)
      throw new OperationError(
        '네이버 변형 출제를 사용할 수 없습니다. 기존 문항으로 구성할 수 있습니다.',
        503,
      );
    items = await ctx.services.examVariants(request, items);
  }
  staff(ctx);
  const id = randomUUID();
  ctx.db
    .prepare(
      'INSERT INTO op_exam_papers(id,academy,owner,request,variant,items,request_key) VALUES(?,?,?,?,?,?,?) ON CONFLICT(academy,owner,request_key) DO NOTHING',
    )
    .run(
      id,
      ...scope(ctx),
      request,
      Number(variant),
      JSON.stringify(items),
      key,
    );
  const saved = get()!;
  if (saved.request !== request || Boolean(saved.variant) !== variant)
    throw new OperationError('이미 사용한 요청입니다.', 409);
  return route + '?paper=' + saved.id;
}
async function submit(ctx: PageContext, form: FormData) {
  staff(ctx);
  const action = field(form, 'action');
  if (action === 'upload') {
    const file = form.get('file');
    if (!file || typeof file === 'string' || !file.size)
      throw new OperationError('문제 파일을 선택해 주세요.');
    const maxBytes = Math.min(ctx.maxDocumentBytes ?? 5242880, 5242880);
    if (file.size > maxBytes)
      throw new OperationError('5 MiB 이하의 문제 파일을 선택해 주세요.', 413);
    const grade = required(form, 'grade', '학년', 80),
      subject = required(form, 'subject', '과목', 80),
      topic = required(form, 'topic', '단원', 80),
      level = required(form, 'level', '난이도', 80);
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      if (
        !['pdf', 'docx', 'hwpx', 'txt', 'markdown'].includes(
          detectFormat(bytes, file.name),
        )
      )
        throw new OperationError('지원하는 문서 형식으로 변환해 주세요.', 415);
      const parsed = await parseSourceFile({
        bytes,
        fileName: file.name,
        limits: { maxBytes, maxPages: 60, maxOcrPages: 0 },
        ocr: null,
      });
      if (
        parsed.status === 'failed' ||
        !parsed.text.trim() ||
        parsed.pages.some((p) => p.method === 'empty')
      )
        throw new OperationError(
          '읽을 수 없는 쪽이 있습니다. 스캔본은 텍스트 PDF나 문서로 변환해 주세요.',
          422,
        );
      const draft = parsed.text.replace(/<!--\s*page \d+\s*-->/g, '').trim();
      if (draft.length > 90000)
        throw new OperationError('문서가 깁니다. 단원별로 나누어 주세요.', 413);
      staff(ctx);
      const id = randomUUID();
      ctx.db
        .prepare(
          'INSERT INTO op_exam_sources(id,academy,owner,title,subject,grade,topic,level,draft,questions) VALUES(?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          ...scope(ctx),
          file.name.slice(0, 160),
          subject,
          grade,
          topic,
          level,
          draft,
          '[]',
        );
      return route + '?source=' + id;
    } finally {
      bytes.fill(0);
    }
  }
  if (action === 'approve') {
    const s = sourceRow(ctx, required(form, 'source', '자료', 80));
    if (s.draft === null) return route + '?source=' + s.id;
    if (field(form, 'checked') !== 'yes')
      throw new OperationError('학생용 문항과 정답 구분을 확인해 주세요.');
    const qs = parseQuestions(required(form, 'text', '문제 내용', 90000));
    if (!qs.length)
      throw new OperationError(
        '번호가 있는 문항을 찾지 못했습니다. 각 문제를 ‘1. 문제’ 형식으로 작성해 주세요.',
        422,
      );
    ctx.db
      .prepare(
        'UPDATE op_exam_sources SET draft=NULL,questions=? WHERE id=? AND academy=? AND owner=? AND draft IS NOT NULL',
      )
      .run(JSON.stringify(qs), s.id, ...scope(ctx));
    return route;
  }
  if (action === 'edit') {
    const paper = paperRow(ctx, required(form, 'paper', '시험지', 80));
    const items = JSON.parse(paper.items) as ExamItem[];
    const prompts = form.getAll('prompt'),
      answers = form.getAll('answer');
    if (prompts.length !== items.length || answers.length !== items.length)
      throw new OperationError('모든 문항을 확인해 주세요.');
    const next = items.map((item, i) => {
      const prompt = prompts[i],
        answer = answers[i];
      if (
        typeof prompt !== 'string' ||
        !prompt.trim() ||
        prompt.length > 3500 ||
        typeof answer !== 'string' ||
        answer.length > 1500 ||
        /(?:정답|해설|풀이|answer)\s*[:：]/i.test(prompt)
      )
        throw new OperationError(
          '문제와 정답을 구분하고 길이를 확인해 주세요.',
        );
      return { ...item, prompt: prompt.trim(), answer: answer.trim() };
    });
    const updated = ctx.db
      .prepare(
        'UPDATE op_exam_papers SET items=?,revision=revision+1 WHERE id=? AND academy=? AND owner=? AND revision=?',
      )
      .run(
        JSON.stringify(next),
        paper.id,
        ...scope(ctx),
        Number(field(form, 'revision')),
      );
    if (!updated.changes)
      throw new OperationError(
        '다른 창에서 시험지가 수정됐습니다. 다시 열어 주세요.',
        409,
      );
    return route + '?paper=' + paper.id + '&sheet=key';
  }
  if (action === 'build')
    return buildExam(
      ctx,
      required(form, 'request', '출제 요청', 400),
      required(form, 'key', '요청', 80),
      field(form, 'variant') === 'yes',
    );
  throw new OperationError('알 수 없는 작업입니다.');
}
export const examBuilderModule: OperationModule = {
  path: route,
  label: '시험지 제작',
  roles: ['teacher', 'admin'],
  setup,
  render: (ctx) =>
    (ctx.formError
      ? '<p class="notice" role="alert">' + h(ctx.formError) + '</p>'
      : '') + render(ctx),
  submit,
};
