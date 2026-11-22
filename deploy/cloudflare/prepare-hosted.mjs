import { appendFileSync, cpSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { renderFormControlStyles } from '../../src/features/academy-operations/form-control-styles.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = join(root, 'src/features/academy-operations');
const assets = join(root, '.local/cloudflare-hosted-assets');
const modules = join(root, '.local/cloudflare-hosted-modules');
mkdirSync(assets, { recursive: true });
mkdirSync(join(modules, 'academies'), { recursive: true });
cpSync(
  join(root, 'src/features/question-classification/rubrics'),
  join(modules, 'rubrics'),
  { recursive: true },
);

for (const name of [
  'operations.css',
  'service-design.css',
  'service-ui.js',
  'app.webmanifest',
  '.well-known',
  'service-worker.js',
  'workbook-ui.js',
  'voice-ui.js',
  'voice-worklet.js',
  'assets',
]) {
  cpSync(join(source, name), join(assets, name), { recursive: true });
}
appendFileSync(
  join(assets, 'service-design.css'),
  '\n' + renderFormControlStyles(),
);
cpSync(
  join(root, 'src/features/makeup-schedule/academies/AC_TEST_A'),
  join(modules, 'academies/AC_TEST_A'),
  { recursive: true },
);
const supplement = join(root, 'deploy/cloudflare/demo-consultation');
const demoAcademy = join(modules, 'academies/AC_TEST_A');
cpSync(join(supplement, 'documents'), join(demoAcademy, 'documents'), {
  recursive: true,
});
appendFileSync(
  join(demoAcademy, 'facts.jsonl'),
  '\n' + readFileSync(join(supplement, 'facts.jsonl'), 'utf8'),
);
for (const name of ['cmaps', 'standard_fonts']) {
  cpSync(join(root, 'node_modules/pdfjs-dist', name), join(modules, name), {
    recursive: true,
  });
}
