import { randomUUID } from 'node:crypto';
import { accessibleClasses } from './directory.ts';
import { pendingMakeupNotices } from './makeup-polls.ts';
import { createParentTemplate } from './parent-message-template.ts';
import {
  assertParentAdmin,
  createParentNotice,
  messageCurrent,
  monthlyEvidence,
  parentPolicy,
  parentMessageHistory,
  prepareMonthlyMessages,
  previousReportMonth,
  queueParentBatch,
  saveParentPolicy,
  setupParentMessages,
  visibleParentMessages,
  type ParentMessage,
} from './parent-messages-model.ts';
import {
  escapeHtml as h,
  field,
  one,
  required,
  transaction,
  OperationError,
  type OperationModule,
  type PageContext,
} from './shared.ts';

const stateLabels = {
  draft: '검토 대기',
  queued: '예약됨',
  delivered: '전달됨',
  cancelled: '취소됨',
};
const time = (s: string) =>
  new Date(s).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
function parentContent(
  ctx: PageContext,
  m: ParentMessage,
  evidence?: ReturnType<typeof monthlyEvidence>,
) {
  if (!messageCurrent(ctx.db, m, evidence))
    return '<p class="notice">수신 대상 또는 학습 자료가 변경되어 이전 내용을 표시하지 않습니다. 학원에 문의해 주세요.</p>';
  const sources = JSON.parse(m.sources) as {
    documentId: string;
    revision: number;
    title: string;
  }[];
  return `<p class="preserve parent-message-body">${h(m.body)}</p>${sources.length ? `<details class="source-details"><summary>학습 근거 ${sources.length}개</summary><ul>${sources.map((s) => `<li><a href="/learning?publication=${encodeURIComponent(s.documentId)}">${h(s.title)}</a> · v${s.revision}</li>`).join('')}</ul></details>` : ''}`;
}
function renderParentMessages(ctx: PageContext) {
  const all =
      ctx.actor.role === 'admin' &&
      !ctx.url.searchParams.has('id') &&
      !ctx.url.searchParams.has('batch')
        ? parentMessageHistory(ctx)
        : visibleParentMessages(ctx),
    selected = all.find((m) => m.id === ctx.url.searchParams.get('id'));
  const evidence = all.some((m) => m.kind === 'monthly')
    ? monthlyEvidence(ctx.db, ctx.actor.academyId)
    : undefined;
  if (ctx.url.searchParams.has('id') && !selected)
    throw new OperationError('알림을 찾을 수 없습니다.', 404);
  const admin = ctx.actor.role === 'admin';
  const note =
    ctx.url.searchParams.get('saved') === '1'
      ? '<p class="notice" role="status">설정을 저장했습니다.</p>'
      : ctx.url.searchParams.get('created') === '1'
        ? '<p class="notice" role="status">초안을 만들었습니다. 대상과 내용을 확인해 주세요.</p>'
        : ctx.url.searchParams.get('ai') === '1'
          ? '<p class="notice" role="status">AI 문구를 만들었습니다. 자동 발송 설정은 기존 상태를 유지합니다.</p>'
          : '';
  const heading = `<div class="workspace-heading"><div><h1>${admin ? '학부모 알림' : '학원 알림'}</h1><p class="muted">${admin ? '월간 리포트와 학원 안내를 학부모 알림함으로 전달합니다.' : '학원에서 보낸 안내와 자녀의 월간 학습 리포트입니다.'}</p></div></div>${ctx.formError ? `<p class="notice" role="alert">${h(ctx.formError)}</p>` : ''}${note}`;
  if (!admin)
    return (
      heading +
      (selected ? '' : pendingMakeupNotices(ctx)) +
      (selected
        ? `<article class="panel"><div class="panel-heading"><h2>${h(selected.title)}</h2><span class="muted">${time(selected.delivered_at!)}</span></div>${parentContent(ctx, selected, evidence)}<form method="post"><input type="hidden" name="id" value="${h(selected.id)}"><button name="action" value="read" class="secondary">읽음으로 표시</button></form><a href="/messages">알림 목록</a></article>`
        : `<section class="panel"><ul class="record-list">${all.map((m) => `<li><a href="/messages?id=${encodeURIComponent(m.id)}"><span class="record-copy"><strong>${h(m.title)}${m.read_at ? '' : ' · 새 알림'}</strong><small>${time(m.delivered_at!)}</small></span><span aria-hidden="true">›</span></a></li>`).join('') || '<li>받은 알림이 없습니다.</li>'}</ul></section>`)
    );
  const view = ctx.url.searchParams.get('view') ?? 'monthly',
    stored = parentPolicy(ctx.db, ctx.actor.academyId),
    classes = accessibleClasses(ctx.db, ctx.actor);
  const policy =
    ctx.submittedForm &&
    ['settings', 'ai'].includes(field(ctx.submittedForm, 'action'))
      ? {
          ...stored,
          template:
            field(ctx.submittedForm, 'template', 3000) || stored.template,
          day: Number(field(ctx.submittedForm, 'day')) || stored.day,
          hour: Number(field(ctx.submittedForm, 'hour')) || stored.hour,
          class_id: field(ctx.submittedForm, 'classId'),
          enabled: ctx.submittedForm.has('enabled') ? 1 : 0,
          automatic: ctx.submittedForm.has('automatic') ? 1 : 0,
        }
      : stored;
  const classOptions = (value = '') =>
    `<option value="">전체 수강 반</option>${classes.map((c) => `<option value="${h(c.id)}"${c.id === value ? ' selected' : ''}>${h(c.name)}</option>`).join('')}`;
  const nav = `<nav class="page-tabs parent-message-tabs" aria-label="알림 관리"><a href="/messages"${view === 'monthly' ? ' aria-current="page"' : ''}>정기 리포트</a><a href="/messages?view=notice"${view === 'notice' ? ' aria-current="page"' : ''}>새 공지</a><a href="/messages?view=history"${view === 'history' ? ' aria-current="page"' : ''}>발송 내역</a></nav>`;
  if (selected)
    return (
      heading +
      nav +
      `<article class="panel"><div class="panel-heading"><h2>${h(selected.title)}</h2><span class="pill">${stateLabels[selected.state]}</span></div>${parentContent(ctx, selected, evidence)}<p class="muted">${selected.delivered_at ? '전달 ' + time(selected.delivered_at) : '예정 ' + time(selected.scheduled_at)} · ${selected.read_at ? '읽음' : '읽지 않음'}</p></article>`
    );
  if (view === 'notice')
    return (
      heading +
      nav +
      `<section class="panel"><h2>학원 안내 작성</h2><form method="post"><input type="hidden" name="requestId" value="${randomUUID()}"><label>제목<input name="title" maxlength="100" required></label><label>수신 대상<select name="classId">${classOptions()}</select></label><label>내용<textarea name="template" rows="7" maxlength="3000" required>{{학생명}} 학부모님, 안녕하세요. {{학원명}}입니다.

</textarea></label><p class="muted">{{학생명}}, {{학원명}}은 학생별로 자동 입력됩니다. 학생별 알림이 각각 생성됩니다.</p><label>전달 예정 (한국시간, 비우면 즉시)<input type="datetime-local" name="scheduledAt"></label><button name="action" value="notice">수신 대상·내용 미리보기</button></form></section>`
    );
  const batch = ctx.url.searchParams.get('batch');
  const items = batch ? all.filter((m) => m.batch_id === batch) : all;
  const batches = [...new Set(items.map((m) => m.batch_id))];
  const history = `<section class="panel"><h2>${batch ? '발송 미리보기' : '발송 내역'}</h2>${
    batches
      .map((id) => {
        const ms = items.filter((m) => m.batch_id === id),
          first = ms[0],
          pending = ms.some((m) => m.state === 'draft'),
          queued = ms.some((m) => m.state === 'queued');
        const counts = one<{ total: number; seen: number }>(
          ctx.db,
          'SELECT COUNT(*) AS total,COUNT(read_at) AS seen FROM op_parent_messages WHERE academy_id=? AND batch_id=?',
          ctx.actor.academyId,
          id,
        )!;
        return `<article class="parent-batch"><div class="panel-heading"><h3>${h(first.kind === 'monthly' ? first.period + ' 월간 학습 리포트' : first.title)}</h3><span class="muted">${counts.total}건 · 읽음 ${counts.seen}건</span></div><details${batch ? ' open' : ''}><summary>수신 대상과 내용 보기</summary>${ms.map((m) => `<div class="parent-recipient"><strong>${h(one<{ name: string }>(ctx.db, 'SELECT name FROM accounts WHERE academy_id=? AND id=?', ctx.actor.academyId, m.guardian_id)?.name ?? '학부모')} · ${stateLabels[m.state]}</strong>${parentContent(ctx, m, evidence)}<a href="/messages?id=${encodeURIComponent(m.id)}">상세 보기</a></div>`).join('')}${counts.total > ms.length ? `<a href="/messages?view=history&amp;batch=${encodeURIComponent(id)}">전체 수신 대상 ${counts.total}건 보기</a>` : ''}</details><form method="post" class="actions"><input type="hidden" name="batch" value="${h(id)}">${pending ? '<button name="action" value="send">알림함에 전달 · 예약 확정</button>' : ''}${pending || queued ? '<button class="secondary" name="action" value="cancel">발송 취소</button>' : ''}</form></article>`;
      })
      .join('') || '<p class="muted">작성한 알림이 없습니다.</p>'
  }</section>`;
  if (view === 'history') return heading + nav + history;
  return (
    heading +
    nav +
    `<div class="split parent-settings"><section class="panel"><h2>매월 리포트 설정</h2><form method="post"><input type="hidden" name="version" value="${policy.version}"><label class="check-label"><input type="checkbox" name="enabled"${policy.enabled ? ' checked' : ''}>정기 리포트 사용</label><input type="hidden" name="automatic" value=""><p>매월 초안을 준비하고, 저장된 내용을 검토·승인한 뒤 전달합니다.</p><div class="fields"><label>매월 날짜<select name="day">${Array.from({ length: 28 }, (_, i) => `<option value="${i + 1}"${policy.day === i + 1 ? ' selected' : ''}>${i + 1}일</option>`).join('')}</select></label><label>시각 (한국시간)<select name="hour">${Array.from({ length: 13 }, (_, i) => `<option value="${i + 8}"${policy.hour === i + 8 ? ' selected' : ''}>${i + 8}:00</option>`).join('')}</select></label></div><label>수신 대상<select name="classId">${classOptions(policy.class_id)}</select></label><p class="muted">선택한 날짜에 전월의 승인된 기록을 모읍니다. 기록이 없는 학생에게는 임의의 리포트를 보내지 않습니다. 최종 내용은 항상 검토 대기에 보관합니다.</p><p class="muted">기본 문구를 그대로 사용할 수 있습니다. 수신 대상과 날짜를 저장하면 매월 초안을 자동 준비합니다. 공개 전에는 담당자가 내용을 검토합니다.</p><details><summary>문구 꾸미기 (선택)</summary><label>안내 문구<textarea name="template" rows="9" maxlength="3000" required>${h(policy.template)}</textarea></label><p class="muted">{{학생명}} · {{학원명}} · {{분석월}} · {{학습요약}}을 각각 한 번 사용하세요. 실제 값은 서버가 자동 입력합니다.</p><div class="actions"><label>AI 말투<select name="tone"><option>정중하게</option><option>따뜻하게</option><option>간결하게</option></select></label><button class="secondary" name="action" value="ai" formnovalidate>AI 문구 만들기</button></div><p class="muted">AI에는 학생 이름·학습 기록을 보내지 않고 안내용 문구만 요청합니다.</p></details><button name="action" value="settings">설정 저장</button></form></section><section class="panel"><h2>먼저 확인해 보기</h2><form method="post"><label>분석 월<input type="month" name="period" value="${previousReportMonth(Date.now())}" required></label><button name="action" value="prepare">리포트 미리보기 만들기</button></form><p class="muted">저장한 문구와 대상 반을 사용합니다. 같은 학생·학부모·분석 월에는 중복 발송하지 않습니다.</p><a href="/messages?view=history">전체 발송 내역</a></section></div>`
  );
}
async function submitParentMessages(ctx: PageContext, form: FormData) {
  const action = field(form, 'action');
  if (action === 'read') {
    if (ctx.actor.role !== 'guardian')
      throw new OperationError('학부모 권한이 필요합니다.', 403);
    const msg = visibleParentMessages(ctx).find(
      (m) => m.id === field(form, 'id'),
    );
    if (!msg) throw new OperationError('알림을 찾을 수 없습니다.', 404);
    ctx.db
      .prepare(
        'UPDATE op_parent_messages SET read_at=COALESCE(read_at,?) WHERE id=? AND academy_id=? AND guardian_id=?',
      )
      .run(new Date().toISOString(), msg.id, ctx.actor.academyId, ctx.actor.id);
    return '/messages?id=' + encodeURIComponent(msg.id);
  }
  assertParentAdmin(ctx);
  const old = parentPolicy(ctx.db, ctx.actor.academyId);
  if (action === 'settings')
    saveParentPolicy(ctx, {
      ...old,
      version: Number(field(form, 'version')),
      enabled: form.has('enabled') ? 1 : 0,
      automatic: form.has('automatic') ? 1 : 0,
      day: Number(field(form, 'day')),
      hour: Number(field(form, 'hour')),
      class_id: field(form, 'classId'),
      template: required(form, 'template', '안내 문구', 3000),
    });
  else if (action === 'ai') {
    const template = await createParentTemplate(field(form, 'tone'));
    ctx.assertCurrentAccess?.();
    saveParentPolicy(ctx, {
      ...old,
      version: Number(field(form, 'version')),
      template,
    });
    return '/messages?ai=1';
  } else if (action === 'prepare') {
    const r = prepareMonthlyMessages(
      ctx.db,
      ctx.actor.academyId,
      required(form, 'period', '분석 월'),
      old,
      Date.now(),
      true,
    );
    if (!r.recipients || r.missing === r.recipients)
      throw new OperationError(
        '선택한 월의 승인된 학습 기록과 연결된 학부모 계정을 확인해 주세요.',
        422,
      );
    return (
      '/messages?view=history&batch=' +
      encodeURIComponent(r.batch) +
      '&created=1'
    );
  } else if (action === 'notice') {
    const date = field(form, 'scheduledAt');
    if (date && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(date))
      throw new OperationError('전달 예정 일시를 확인해 주세요.', 422);
    const timestamp = date ? Date.parse(date + ':00+09:00') : Date.now();
    if (!Number.isFinite(timestamp))
      throw new OperationError('전달 예정 일시를 확인해 주세요.', 422);
    if (
      date &&
      new Date(timestamp + 9 * 3600000).toISOString().slice(0, 16) !== date
    )
      throw new OperationError('실제 존재하는 날짜를 선택해 주세요.', 422);
    const at = new Date(timestamp).toISOString();
    const batch = createParentNotice(ctx, {
      requestId: required(form, 'requestId', '요청 번호'),
      title: required(form, 'title', '제목', 100),
      template: required(form, 'template', '내용', 3000),
      classId: field(form, 'classId'),
      scheduledAt: at,
    });
    return (
      '/messages?view=history&batch=' + encodeURIComponent(batch) + '&created=1'
    );
  } else if (action === 'send') {
    queueParentBatch(ctx, required(form, 'batch', '발송 묶음'));
    return '/messages?view=history';
  } else if (action === 'cancel') {
    transaction(ctx.db, () =>
      ctx.db
        .prepare(
          "UPDATE op_parent_messages SET state='cancelled' WHERE academy_id=? AND batch_id=? AND state IN('draft','queued')",
        )
        .run(ctx.actor.academyId, required(form, 'batch', '발송 묶음')),
    );
    return '/messages?view=history';
  } else throw new OperationError('지원하지 않는 요청입니다.');
  return '/messages?saved=1';
}
export const parentMessagesModule: OperationModule = {
  path: '/messages',
  label: '학부모 알림',
  roles: ['admin', 'guardian'],
  setup: setupParentMessages,
  render: renderParentMessages,
  submit: submitParentMessages,
};
