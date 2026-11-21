import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderReportDocument } from './report-document.ts';

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
    /<dl class="report-highlights"><div><dt>성취도<\/dt><dd>3 \/ 4문항 정답<\/dd><\/div><div><dt>다음 학습<\/dt><dd>통분 유형을 연습합니다\.<\/dd><\/div><\/dl>/,
  );
  assert.match(html, /<h3>유형별 성취도<\/h3>/);
  assert.ok(html.indexOf('report-save') > html.indexOf('report-table'));
  assert.ok(html.includes(encodeURIComponent(markdown)));
});
