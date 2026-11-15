import { randomUUID } from 'node:crypto';
import { accessibleClasses } from './directory.ts';
import { escapeHtml as h, type PageContext } from './shared.ts';

export function renderWorkbookForm(ctx: PageContext) {
  const classes = accessibleClasses(ctx.db, ctx.actor).flatMap((c) => {
    const math = /수학|math/i.test(c.subject),
      english = /영어|english/i.test(c.subject);
    return math === english ? [] : [{ ...c, subject: math ? 'M' : 'E' }];
  });
  if (!classes.length)
    return '<section class="panel"><h2>숙제 등록</h2><p>담당 수학·영어 반을 먼저 연결해 주세요.</p></section>';
  return `<section id="homework-create" class="panel"><h2>숙제 등록</h2>
  <form id="workbook-photo"><h3>교재 사진 분석</h3><div class="fields">
    <label>과목<select name="subject">${[...new Set(classes.map((c) => c.subject))].map((s) => `<option value="${s}">${s === 'M' ? '수학' : '영어'}</option>`).join('')}</select></label>
    <label>교재 이름<input name="book" maxlength="120" required></label>
    <label>쪽수<input name="page" type="number" value="1" min="1" max="100000" required></label>
    <label>구간 (선택)<input name="segment" maxlength="120" placeholder="예: 연습문제"></label></div>
    <label>교재 사진 (PNG·JPEG, 최대 5MB)<input type="file" name="photo" accept="image/png,image/jpeg" required></label>
    <p>사진을 한 장씩 분석하면 아래 목록에 문항이 추가됩니다. 사진 원본은 저장하지 않습니다.</p>
    <img id="workbook-preview" hidden class="homework-photo" alt="분석할 교재 사진">
    <button>사진 분석하기</button></form>
  <form id="workbook-save" method="post" action="/homework"><input type="hidden" name="action" value="save-workbook">
    <input type="hidden" name="assignmentId" value="${randomUUID()}">
    <h3>문항 확인·수정</h3><div id="workbook-rows"></div>
    <button type="button" class="secondary" id="workbook-add">문항 직접 추가</button>
    <h3>숙제 배정</h3><div class="fields">
    <label>반<select name="classId" required>${classes.map((c) => `<option data-subject="${c.subject}" value="${h(c.id)}">${h(c.name)}</option>`).join('')}</select></label>
    <label>숙제 이름<input name="title" maxlength="120" required></label>
    <label>숙제 날짜<input type="date" name="date" required value="${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' })}"></label></div>
    <label class="check-label"><input type="checkbox" name="reviewed" value="yes" required>출제할 문항과 유형을 확인했습니다.</label>
    <button>선택한 문항으로 숙제 배정</button></form>
    <p id="workbook-status" role="status" aria-live="polite"></p>
    <template id="workbook-row"><fieldset><legend><label><input type="checkbox" data-select checked> 출제</label></legend>
    <p data-reading></p><div class="fields">
    <label>교재<input data-field="book" maxlength="120"></label><label>쪽<input data-field="page" type="number" min="1" max="100000"></label>
    <label>문항 번호<input data-field="number" maxlength="80"></label>
    <label>구간<input data-field="segment" maxlength="120"></label><label>출제 유형<input data-field="type" maxlength="500"></label>
    </div><button type="button" data-remove class="secondary">문항 삭제</button></fieldset></template>
  </section><script src="/workbook-ui.js" defer></script>`;
}
