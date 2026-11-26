import { escapeHtml as h } from './shared.ts';

const teacherCommentHeading = '## 교사 코멘트';

export function reportTeacherComment(body: string) {
  const section =
    /^## 교사 코멘트[ \t]*(?:\r?\n|$)([\s\S]*?)(?=^#{1,2} |(?![\s\S]))/mu.exec(
      body,
    );
  return section
    ? {
        body: (
          body.slice(0, section.index) +
          body.slice(section.index + section[0].length)
        ).trim(),
        comment: section[1].trim(),
      }
    : { body, comment: '' };
}

export function withTeacherComment(body: string, comment: string) {
  return comment
    ? [
        body,
        teacherCommentHeading,
        comment.replace(/^[ \t]*(?=#{1,3} )/gmu, '· '),
      ].join('\n\n')
    : body;
}

function cells(line: string) {
  return line
    .slice(1, -1)
    .split('|')
    .map((text) => text.trim());
}

function summaryMeter(text: string) {
  const full = /^교사 확정 (\d+)문항 중 (\d+)문항 정답/u.exec(text);
  const fraction = /^(\d+)\s*\/\s*(\d+)문항 정답/u.exec(text);
  const total = Number(full?.[1] ?? fraction?.[2]);
  const correct = Number(full?.[2] ?? fraction?.[1]);
  return Number.isSafeInteger(total) && total > 0 && correct <= total
    ? '<meter min="0" max="' +
        total +
        '" value="' +
        correct +
        '" aria-label="전체 정답률"></meter>'
    : '';
}

function learningBars(lines: string[]) {
  if (cells(lines[0]).join('|') !== '학습 유형|정답|전체') return '';
  const values = lines.slice(2).map((line) => {
    const [label, correct, total, ...remainder] = cells(line);
    if (
      !label ||
      remainder.length ||
      !/^\d+$/u.test(correct) ||
      !/^\d+$/u.test(total)
    )
      return;
    return { label, correct: Number(correct), total: Number(total) };
  });
  if (
    values.some(
      (v) =>
        !v || !Number.isSafeInteger(v.total) || !v.total || v.correct > v.total,
    )
  )
    return '';
  return (
    '<ul class="report-meters" aria-label="유형별 정답률">' +
    values
      .map((v) => {
        const { label, correct, total } = v!;
        const percent = Math.round((100 * correct) / total);
        return (
          '<li><span class="report-meter-label">' +
          h(label) +
          '</span><strong>' +
          correct +
          ' / ' +
          total +
          '문항</strong><meter min="0" max="' +
          total +
          '" value="' +
          correct +
          '" aria-label="' +
          h(label + ' 정답률') +
          '"></meter><span class="report-meter-rate">' +
          percent +
          '%</span></li>'
        );
      })
      .join('') +
    '</ul>'
  );
}

function inlineMarkdown(text: string) {
  return text
    .split(/(\*\*[^*\r\n]+\*\*|`[^`\r\n]+`)/u)
    .map((part, index) =>
      index % 2 === 0
        ? h(part)
        : part.startsWith('**')
          ? '<strong>' + h(part.slice(2, -2)) + '</strong>'
          : '<code>' + h(part.slice(1, -1)) + '</code>',
    )
    .join('');
}

function markdownTable(lines: string[], showLearningBars: boolean) {
  const row = (line: string, tag: 'th' | 'td') =>
    '<tr>' +
    cells(line)
      .map(
        (cell) =>
          '<' +
          tag +
          (tag === 'th' ? ' scope="col"' : '') +
          '>' +
          inlineMarkdown(cell) +
          '</' +
          tag +
          '>',
      )
      .join('') +
    '</tr>';
  const table =
    '<div class="report-table"><table><thead>' +
    row(lines[0], 'th') +
    '</thead><tbody>' +
    lines
      .slice(2)
      .map((line) => row(line, 'td'))
      .join('') +
    '</tbody></table></div>';
  const visual = showLearningBars ? learningBars(lines) : '';
  return visual
    ? visual +
        '<details class="report-values"><summary>수치 표로 보기</summary>' +
        table +
        '</details>'
    : table;
}

/** Render a Markdown subset with all user and model text escaped. */
export function renderOutputMarkdown(text: string, report = false) {
  const lines = text.split(/\r?\n/u).map((line) => line.trim());
  const divider = /^\|(?:\s*:?-{3,}:?\s*\|)+$/u;
  const tableRow = /^\|.*\|$/u;
  const bullet = /^[-*+]\s+/u;
  const numbered = /^(\d{1,9})[.)]\s+/u;
  const quote = /^>\s?/u;
  const html: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (
      tableRow.test(line) &&
      divider.test(lines[i + 1] ?? '') &&
      tableRow.test(lines[i + 2] ?? '')
    ) {
      const start = i;
      i += 2;
      while (tableRow.test(lines[i + 1] ?? '')) i++;
      html.push(markdownTable(lines.slice(start, i + 1), report));
      continue;
    }
    const counts = report
      ? /^(?:출결 기록:\s*)?출석 (\d+)(?:건|회) · 지각 (\d+)(?:건|회) · 결석 (\d+)(?:건|회)$/u.exec(
          line,
        )
      : null;
    if (counts) {
      html.push(
        '<dl class="report-attendance">' +
          ['출석', '지각', '결석']
            .map(
              (label, index) =>
                '<div><dt>' +
                label +
                '</dt><dd>' +
                counts[index + 1] +
                '회</dd></div>',
            )
            .join('') +
          '</dl>',
      );
      continue;
    }
    const group = [bullet, numbered, quote].find((pattern) =>
      pattern.test(line),
    );
    if (group) {
      const start = i;
      while (group.test(lines[i + 1] ?? '')) i++;
      const tag =
        group === bullet ? 'ul' : group === numbered ? 'ol' : 'blockquote';
      const item = group === quote ? 'p' : 'li';
      html.push(
        '<' +
          tag +
          '>' +
          lines
            .slice(start, i + 1)
            .map(
              (value) =>
                '<' +
                item +
                (group === numbered
                  ? ' value="' + numbered.exec(value)?.[1] + '"'
                  : '') +
                '>' +
                inlineMarkdown(value.replace(group, '')) +
                '</' +
                item +
                '>',
            )
            .join('') +
          '</' +
          tag +
          '>',
      );
      continue;
    }
    html.push(
      /^#{1,6} /u.test(line)
        ? '<h3>' + inlineMarkdown(line.replace(/^#{1,6} /u, '')) + '</h3>'
        : '<p>' + inlineMarkdown(line) + '</p>',
    );
  }
  return html.join('');
}

/** Add report metadata, key figures, charts, and the Markdown download. */
export function renderReportDocument(
  title: string,
  body: string,
  subtitle: string,
  filename: string,
  reference?: string,
) {
  const markdown = body.startsWith('# ') ? body : '# ' + title + '\n\n' + body;
  const { body: reportBody, comment } = reportTeacherComment(markdown);
  const blocks = reportBody
    .replace(/^# [^\n]*\n*/, '')
    .trim()
    .split(/\r?\n\s*\r?\n/);
  const highlights: { label: string; text: string }[] = [];
  for (const label of ['성취도', '다음 학습']) {
    const index = blocks.indexOf('## ' + label);
    if (index < 0) continue;
    const text = blocks[index + 1];
    if (!text || /^(?:[#|]|- )/.test(text) || text.includes('\n')) continue;
    const remaining = blocks[index + 2];
    const heading =
      remaining && !remaining.startsWith('#')
        ? label === '성취도' && remaining.startsWith('|')
          ? '## 유형별 성취도'
          : '## ' + label
        : '';
    highlights.push({ label, text });
    blocks.splice(index, 2, ...(heading ? [heading] : []));
  }
  const content = renderOutputMarkdown(
    blocks
      .filter((block, index) => index !== 0 || block !== subtitle)
      .join('\n\n'),
    true,
  );
  return (
    '<article class="report-document"><header class="report-document-header"><div><h2>' +
    h(title) +
    '</h2><p>' +
    h(subtitle) +
    '</p></div></header>' +
    (highlights.length
      ? '<dl class="report-highlights">' +
        highlights
          .map(
            ({ label, text }) =>
              '<div><dt>' +
              h(label) +
              '</dt><dd>' +
              h(text) +
              (label === '성취도' ? summaryMeter(text) : '') +
              '</dd></div>',
          )
          .join('') +
        '</dl>'
      : '') +
    '<div class="report-document-body formatted-output">' +
    content +
    (reference
      ? '<details class="report-values"><summary>집계 근거와 기준</summary>' +
        reference
          .split(/\r?\n\s*\r?\n/u)
          .map((line) => '<p>' + h(line) + '</p>')
          .join('') +
        '</details>'
      : '') +
    (comment
      ? '<section class="report-teacher-note"><h3>교사 코멘트</h3>' +
        comment
          .split(/\r?\n\s*\r?\n/u)
          .map((text) => '<p>' + h(text) + '</p>')
          .join('') +
        '</section>'
      : '') +
    '</div><details class="report-save"><summary>리포트 저장</summary><a class="button-link subtle-link" download="' +
    h(filename) +
    '.md" href="data:text/markdown;charset=utf-8,' +
    encodeURIComponent(
      reference
        ? markdown + '\n\n## 집계 근거와 기준\n\n' + reference
        : markdown,
    ) +
    '">Markdown 저장</a></details></article>'
  );
}
