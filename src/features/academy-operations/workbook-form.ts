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

export function renderWorkbookForm(ctx: PageContext) {
  const classes = workbookClasses(ctx),
    books = booksFor(ctx),
    id = ctx.url.searchParams.get('book');
  if (!classes.length)
    return '<section class="panel"><h2>숙제 등록</h2><p>담당 수학·영어 반을 먼저 연결해 주세요.</p></section>';
  if (!id)
    return `<section class="panel"><a href="/homework">숙제 목록</a><h1>숙제 등록 · 교재 선택</h1>
  <form method="get"><input type="hidden" name="view" value="create"><label>학원 교재<select name="book" required><option value="">교재 선택</option>${books
    .filter((b) => classes.some((c) => c.subject === b.subject))
    .map(
      (b) =>
        `<option value="${h(b.id)}">${h(bookLabel(b))} · ${b.subject === 'M' ? '수학' : '영어'}</option>`,
    )
    .join('')}</select></label><button>문항 선택으로</button></form>
  <h2>새 교재 등록</h2><form method="post" action="/homework"><input type="hidden" name="action" value="register-book"><div class="fields">
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
  return `<section class="panel" id="homework-create" data-items="${h(JSON.stringify(items))}" data-tags="${h(JSON.stringify(tagCatalog.tags.filter((t) => t.subject === book.subject)))}">
  <a href="/homework">숙제 목록</a><h1>${h(bookLabel(book))}</h1>
  <div id="workbook-first"><h2>1단계 · 문항 선택</h2>
  <form id="workbook-photo"><input type="hidden" name="subject" value="${book.subject}"><label>교재 사진 한 장 (PNG·JPEG, 최대 5MB)<input type="file" name="photo" accept="image/png,image/jpeg" required></label>
  <button>사진 분석하기</button></form>
  <p>교재와 대조해 쪽수와 번호를 확인하세요. 유형은 핵심 행동이 여러 개일 때 복수 선택할 수 있습니다.</p>
  <div id="workbook-rows"></div><div class="actions"><button type="button" id="workbook-add">문항 직접 추가</button><button type="button" id="workbook-next">다음 · 배정 설정</button></div></div>
  <form id="workbook-save" hidden method="post" action="/homework"><h2>2단계 · 배정 설정</h2><p id="workbook-summary"></p>
  <input type="hidden" name="action" value="assign-workbook"><input type="hidden" name="assignmentId" value="${randomUUID()}"><input type="hidden" name="subject" value="${book.subject}"><input type="hidden" name="bookId" value="${h(id)}"><input type="hidden" name="items">
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
  <div class="actions"><button id="workbook-back" type="button">이전 · 문항 선택</button><button>숙제 배정</button></div></form>
  <p id="workbook-status" role="status" aria-live="polite"></p>
  <template id="workbook-row"><fieldset><legend><label><input type="checkbox" data-select> 출제</label></legend><p data-reading hidden></p>
  <div data-review hidden><label>확인한 원문<textarea data-transcript maxlength="60000"></textarea></label><button type="button" data-reclassify>원문 확인 후 다시 분류</button></div>
  <div class="fields"><label>쪽수<input type="number" data-page min="1" max="100000"></label><label>문항 번호<input data-number maxlength="80"></label>
  <label>대분류<select data-area></select></label></div><div data-minor></div><p data-chosen></p>
  <button type="button" data-remove>목록에서 빼기</button></fieldset></template>
  </section><script defer src="/workbook-ui.js"></script>`;
}
