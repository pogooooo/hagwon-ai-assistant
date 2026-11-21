import { escapeHtml as h } from './shared.ts';

/** A small Markdown subset. Report fields and edited content are always escaped. */
export function renderReportDocument(
  title: string,
  body: string,
  subtitle: string,
  filename: string,
) {
  const markdown = body.startsWith('# ') ? body : '# ' + title + '\n\n' + body;
  const blocks = markdown
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
  const content = blocks
    .filter((block, index) => index !== 0 || block !== subtitle)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const divider = /^\|(?:\s*:?-{3,}:?\s*\|)+$/;
      if (
        lines.length > 2 &&
        divider.test(lines[1]) &&
        lines.every((line) => line.startsWith('|') && line.endsWith('|'))
      ) {
        const row = (line: string, tag: 'th' | 'td') =>
          '<tr>' +
          line
            .slice(1, -1)
            .split('|')
            .map(
              (cell) =>
                '<' +
                tag +
                (tag === 'th' ? ' scope="col"' : '') +
                '>' +
                h(cell.trim()) +
                '</' +
                tag +
                '>',
            )
            .join('') +
          '</tr>';
        return (
          '<div class="report-table"><table><thead>' +
          row(lines[0], 'th') +
          '</thead><tbody>' +
          lines
            .slice(2)
            .map((line) => row(line, 'td'))
            .join('') +
          '</tbody></table></div>'
        );
      }
      if (lines.every((line) => line.startsWith('- ')))
        return (
          '<ul>' +
          lines.map((line) => '<li>' + h(line.slice(2)) + '</li>').join('') +
          '</ul>'
        );
      return lines
        .map((line) =>
          /^#{1,3} /.test(line)
            ? '<h3>' + h(line.replace(/^#{1,3} /, '')) + '</h3>'
            : '<p>' + h(line) + '</p>',
        )
        .join('');
    })
    .join('');
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
              '<div><dt>' + h(label) + '</dt><dd>' + h(text) + '</dd></div>',
          )
          .join('') +
        '</dl>'
      : '') +
    '<div class="report-document-body">' +
    content +
    '</div><details class="report-save"><summary>리포트 저장</summary><a class="button-link subtle-link" download="' +
    h(filename) +
    '.md" href="data:text/markdown;charset=utf-8,' +
    encodeURIComponent(markdown) +
    '">Markdown 저장</a></details></article>'
  );
}
