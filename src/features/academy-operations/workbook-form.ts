import { randomUUID } from 'node:crypto';
import { accessibleStudents } from './directory.ts';
import { tagById, tagCatalog } from './classification.ts';
import {
  booksFor,
  bookLabel,
  workbookClasses,
  bookQuestions,
} from './workbook-catalog.ts';
import { workbookRecipients, renderCatalogList } from './workbook-results.ts';
import { escapeHtml as h, OperationError, type PageContext } from './shared.ts';

export function renderBookList(ctx: PageContext) {
  const books = booksFor(ctx),
    id = ctx.url.searchParams.get('book');
  if (id) {
    const b = books.find((b) => b.id === id);
    if (!b) throw new OperationError('교재를 찾을 수 없습니다.', 404);
    const items = bookQuestions(ctx, id);
    return `<section class="panel"><a href="/homework?view=books">교재 목록</a><h1>${h(bookLabel(b))}</h1><form action="/homework">
    <input type="hidden" name="view" value="create"><input type="hidden" name="book" value="${h(id)}">
    <h2>쪽수별 문항</h2>${items.map((q) => `<label class="check-label"><input type="checkbox" name="pick" value="${h(q.id)}">${q.page}쪽 ${h(q.number)}번 · ${h(q.tagIds.map((t) => tagById.get(t)?.name).join(', ') || '유형 미지정')}</label>`).join('') || '<p>저장된 문항이 없습니다.</p>'}<button>이 교재로 숙제 등록</button></form></section>
    <h2>관련 숙제</h2>${renderCatalogList(
      workbookRecipients(ctx).filter((r) => r.book_id === id),
      true,
    )}`;
  }
  return `<section class="panel"><a href="/homework">숙제 목록</a><h1>교재 목록</h1><ul>${books.map((b) => `<li><a href="/homework?view=books&amp;book=${h(b.id)}">${h(bookLabel(b))}</a> · ${b.subject === 'M' ? '수학' : '영어'}</li>`).join('') || '<li>등록한 교재가 없습니다.</li>'}</ul><a href="/homework?view=create">교재 등록</a></section>`;
}

/**
 * 교재 문항 선택 화면. grading 모드는 사진 채점의 과제 등록 탭에서 쓰며, 문항마다 정답을 함께
 * 입력받고 등록한 정답으로만 채점하는 과제를 만든다(반 단위 배정).
 */
export function renderWorkbookForm(
  ctx: PageContext,
  mode: 'homework' | 'grading' = 'homework',
) {
  const grading = mode === 'grading',
    base = grading ? '/grading' : '/homework',
    view = grading ? 'register' : 'create',
    back = grading ? '' : '<a href="/homework">숙제 목록</a>';
  const classes = workbookClasses(ctx),
    books = booksFor(ctx),
    id = ctx.url.searchParams.get('book');
  if (!classes.length)
    return '<section class="panel"><h2>숙제 등록</h2><p>담당 수학·영어 반을 먼저 연결해 주세요.</p></section>';
  if (!id)
    return `<section class="panel">${back}<h${grading ? 2 : 1}>${grading ? '교재로 과제 만들기' : '숙제 등록'} · 교재 선택</h${grading ? 2 : 1}>${grading ? '<p>처음 쓰는 교재는 사진으로 문항·유형을 찾고 정답을 입력해 두면, 다음 과제부터는 문항만 고르면 됩니다.</p>' : ''}
  <form method="get" action="${base}"><input type="hidden" name="view" value="${view}"><label>학원 교재<select name="book" required><option value="">교재 선택</option>${books
    .filter((b) => classes.some((c) => c.subject === b.subject))
    .map(
      (b) =>
        `<option value="${h(b.id)}">${h(bookLabel(b))} · ${b.subject === 'M' ? '수학' : '영어'}</option>`,
    )
    .join('')}</select></label><button>문항 선택으로</button></form>
  <h${grading ? 3 : 2}>새 교재 등록</h${grading ? 3 : 2}><form method="post" action="${base}"><input type="hidden" name="action" value="register-book"><div class="fields">
  <label>과목<select name="subject">${[...new Set(classes.map((c) => c.subject))].map((s) => `<option value="${s}">${s === 'M' ? '수학' : '영어'}</option>`).join('')}</select></label>
  <label>교재 이름<input name="book" list="known-books" required maxlength="120"><datalist id="known-books">${[...new Set(books.map((b) => b.name))].map((n) => `<option value="${h(n)}"></option>`).join('')}</datalist></label>
  <label>학년<input name="grade" maxlength="40"></label><label>학기<input name="semester" maxlength="40"></label><label>개정판<input name="edition" maxlength="60"></label></div><button>교재 등록 후 문항 선택</button></form></section>`;
  const book = books.find((b) => b.id === id);
  if (!book || !classes.some((c) => c.subject === book.subject))
    throw new OperationError('배정할 교재를 찾을 수 없습니다.', 404);
  const students = accessibleStudents(ctx.db, ctx.actor),
    targets = classes.filter((c) => c.subject === book.subject);
  const picks = new Set(ctx.url.searchParams.getAll('pick'));
  const items = bookQuestions(ctx, id).map((q) => ({
    ...q,
    selected: picks.has(q.id),
  }));
  return `<section class="panel" id="homework-create" data-base="${base}" data-done="${grading ? 'assignment' : 'detail'}"${grading ? ' data-require-answer="1"' : ''} data-items="${h(JSON.stringify(items))}" data-tags="${h(JSON.stringify(tagCatalog.tags.filter((t) => t.subject === book.subject)))}">
  ${back}<h${grading ? 2 : 1}>${h(bookLabel(book))}</h${grading ? 2 : 1}>
  <div id="workbook-first"><h2>1단계 · 문항 선택</h2>
  <form id="workbook-photo"><input type="hidden" name="subject" value="${book.subject}"><label>교재 사진 한 장 (PNG·JPEG, 최대 5MB)<input type="file" name="photo" accept="image/png,image/jpeg" required></label>
  <button>사진 분석하기</button></form>
  <p>교재와 대조해 쪽수와 번호를 확인하세요. ${grading ? '객관식은 보기 번호를 입력하세요. 주관식은 객관식 체크를 해제하고 정답을 적어 주세요. 인정할 답이 여럿이면 | 로 구분합니다. 처음 고른 유형이 대표 유형으로 집계됩니다.' : '유형은 핵심 행동이 여러 개일 때 복수 선택할 수 있습니다.'}</p>
  <div id="workbook-rows"></div><div class="actions"><button type="button" id="workbook-add">문항 직접 추가</button><button type="button" id="workbook-next">다음 · 배정 설정</button></div></div>
  ${grading ? gradingAssignStep(book.subject, id, targets) : homeworkAssignStep(book.subject, id, targets, students)}
  <p id="workbook-status" role="status" aria-live="polite"></p>
  <template id="workbook-row"><fieldset><legend><label><input type="checkbox" data-select> 출제</label></legend><p data-reading hidden></p>
  <div data-review hidden><label>확인한 원문<textarea data-transcript maxlength="60000"></textarea></label><button type="button" data-reclassify>원문 확인 후 다시 분류</button></div>
  <div class="fields"><label>쪽수<input type="number" data-page min="1" max="100000"></label><label>문항 번호<input data-number maxlength="80"></label>
  <label>대분류<select data-area></select></label>${grading ? '<label class="check-label"><input type="checkbox" data-is-choice>객관식</label><label><span data-answer-label>정답</span><input data-answer maxlength="200"></label>' : ''}</div><div data-minor></div><p data-chosen></p>
  <button type="button" data-remove>목록에서 빼기</button></fieldset></template>
  </section><script defer src="/workbook-ui.js"></script>`;
}

function homeworkAssignStep(
  subject: string,
  id: string,
  targets: ReturnType<typeof workbookClasses>,
  students: ReturnType<typeof accessibleStudents>,
) {
  return `<form id="workbook-save" hidden method="post" action="/homework"><h2>2단계 · 배정 설정</h2><p id="workbook-summary"></p>
  <input type="hidden" name="action" value="assign-workbook"><input type="hidden" name="assignmentId" value="${randomUUID()}"><input type="hidden" name="subject" value="${subject}"><input type="hidden" name="bookId" value="${h(id)}"><input type="hidden" name="items">
  <label>숙제 이름<input name="title" maxlength="120" required></label>
  <label>배정 방식<select name="targetKind"><option value="class">반 전체</option><option value="student">학생 개별</option></select></label>
  <fieldset id="class-targets"><legend>배정할 반</legend>${targets.map((c) => `<label class="check-label"><input type="checkbox" name="classId" value="${h(c.id)}">${h(c.name)}</label>`).join('')}</fieldset>
  <fieldset id="student-targets" hidden disabled><legend>배정할 학생</legend>${targets
    .map((c) =>
      students
        .filter((s) => s.classIds.includes(c.id))
        .map(
          (s) =>
            `<label class="check-label"><input type="checkbox" name="recipient" value="${h(c.id + '|' + s.id)}">${h(c.name)} · ${h(s.name)}</label>`,
        )
        .join(''),
    )
    .join('')}</fieldset>
  <div class="fields"><label>마감 날짜<input type="date" name="date" required></label><label>마감 시간 (선택)<input type="time" name="time"></label></div>
  <div class="actions"><button id="workbook-back" type="button">이전 · 문항 선택</button><button>숙제 배정</button></div></form>`;
}
function gradingAssignStep(
  subject: string,
  id: string,
  targets: ReturnType<typeof workbookClasses>,
) {
  return `<form id="workbook-save" hidden method="post" action="/grading"><h3>2단계 · 배정 설정</h3><p id="workbook-summary"></p>
  <input type="hidden" name="action" value="assign-workbook"><input type="hidden" name="request_key" value="${randomUUID()}"><input type="hidden" name="subject" value="${subject}"><input type="hidden" name="bookId" value="${h(id)}"><input type="hidden" name="items"><input type="hidden" name="targetKind" value="class">
  <label>과제 이름<input name="title" maxlength="120" required></label>
  <fieldset id="class-targets"><legend>배정할 반</legend>${targets.map((c) => `<label class="check-label"><input type="checkbox" name="classId" value="${h(c.id)}">${h(c.name)}</label>`).join('')}</fieldset>
  <p>학생은 문항이 있는 쪽을 쪽수 순서대로 찍어 제출합니다. 읽은 답은 등록한 정답과 비교해 자동으로 채점하고, 선생님이 확정한 결과만 집계합니다.</p>
  <label>자료 이용 근거<select name="rights_basis" required><option value="">선택해 주세요</option><option>직접 만든 자료</option><option>사진 채점 이용을 허락받은 자료</option><option>해당 이용이 허용된 공개 자료</option></select></label>
  <label class="check-label"><input type="checkbox" name="approved" value="yes" required>자료 이용 근거와 정답을 확인했습니다.</label>
  <div class="actions"><button id="workbook-back" type="button">이전 · 문항 선택</button><button>과제 등록</button></div></form>`;
}
