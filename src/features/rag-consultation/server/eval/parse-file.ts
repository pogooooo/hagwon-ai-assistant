/** 개발용: 파일 하나를 파싱해 정규화 Markdown·페이지 품질·경고를 출력한다. node parse-file.ts <파일> [--json] */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { parseSourceFile } from '../ingest/parsers/index.ts';

const [file, flag] = process.argv.slice(2);
const parsed = await parseSourceFile({
  bytes: new Uint8Array(readFileSync(file)),
  fileName: basename(file),
});
if (flag === '--json') console.log(JSON.stringify(parsed, null, 2));
else {
  console.log(
    `# ${basename(file)} → ${parsed.format} ${parsed.status}${parsed.error ? ` (${parsed.error})` : ''}`,
    JSON.stringify(parsed.stats),
  );
  console.log('pages', JSON.stringify(parsed.pages));
  console.log('warnings', JSON.stringify(parsed.warnings));
  console.log(parsed.text);
}
