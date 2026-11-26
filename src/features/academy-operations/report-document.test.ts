import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  renderOutputMarkdown,
  renderReportDocument,
} from './report-document.ts';

test('shared output formats mixed Markdown blocks and keeps embedded HTML inert', () => {
  const html = renderOutputMarkdown(
    '## 확인 결과\n**분수 계산**을 다시 연습합니다.\n- 통분하기\n- 약분하기\n\n' +
      '7. 교과서 확인\n9. 오답 다시 풀기\n\n> <script>alert(1)</script>\n\n' +
      '| 유형 | 확인 |\n| --- | ---: |\n| 분수 | 3 |',
  );
  assert.match(html, /<h3>확인 결과<\/h3><p><strong>분수 계산<\/strong>/);
  assert.match(html, /<ul><li>통분하기<\/li><li>약분하기<\/li><\/ul>/);
  assert.match(html, /<ol><li value="7">교과서 확인<\/li><li value="9">/);
  assert.match(html, /<blockquote><p>&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /<th scope="col">유형<\/th>[\s\S]*<td>3<\/td>/);
});

test('report Markdown renders tables and escapes edited content', () => {
  const content =
    '# 11월 리포트\n\n## 성취도\n\n| 학습 유형 | 정답 |\n| --- | ---: |\n| <img src=x onerror=alert(1)> | 3 |\n\n## 다음 학습\n\n- 분모 확인\n- 교사 첨삭';
  const html = renderReportDocument(
    '11월 학습 리포트',
    content,
    '수학',
    '2026-11',
  );
  assert.match(html, /<th scope="col">정답<\/th>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /<ul><li>분모 확인<\/li><li>교사 첨삭<\/li><\/ul>/);
  assert.ok(html.includes(encodeURIComponent(content)));
});

test('canonical monthly report puts achievement and practice above the evidence', () => {
  const markdown =
    '# 월간 리포트\n\n## 성취도\n\n3 / 4문항 정답\n\n| 유형 | 정답 |\n| --- | --- |\n| 분수 | 3 |\n\n## 다음 학습\n\n통분 유형을 연습합니다.';
  const html = renderReportDocument('월간 리포트', markdown, '수학', 'report');
  assert.match(
    html,
    /<dl class="report-highlights"><div><dt>성취도<\/dt><dd>3 \/ 4문항 정답<meter min="0" max="4" value="3" aria-label="전체 정답률"><\/meter><\/dd><\/div><div><dt>다음 학습<\/dt><dd>통분 유형을 연습합니다\.<\/dd><\/div><\/dl>/,
  );
  assert.match(html, /<h3>유형별 성취도<\/h3>/);
  assert.ok(html.indexOf('report-save') > html.indexOf('report-table'));
  assert.ok(html.includes(encodeURIComponent(markdown)));
});

test('charts show original counts while the saved Markdown preserves the table and teacher note', () => {
  const markdown =
    '# 월간 리포트\n\n## 성취도\n\n4 / 5문항 정답\n\n' +
    '| 학습 유형 | 정답 | 전체 |\n| --- | ---: | ---: |\n| 분수 | 4 | 5 |\n\n' +
    '## 교사 코멘트\n\n다음에는 <강조> 통분부터 확인합니다.\n\n' +
    '## 출결\n\n출석 3회 · 지각 1회 · 결석 0회';
  const html = renderReportDocument('학습 리포트', markdown, '수학', 'monthly');
  assert.match(
    html,
    /<meter min="0" max="5" value="4" aria-label="분수 정답률">/,
  );
  assert.match(html, /report-meter-rate">80%/);
  assert.match(html, /<summary>수치 표로 보기<\/summary>/);
  assert.match(html, /<dt>지각<\/dt><dd>1회/);
  assert.match(html, /report-teacher-note[\s\S]*&lt;강조&gt;/);
  assert.ok(html.includes(encodeURIComponent(markdown)));
});
