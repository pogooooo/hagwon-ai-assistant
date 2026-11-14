import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = join(root, 'src/features/academy-operations');
const assets = join(root, '.local/cloudflare-hosted-assets');
const modules = join(root, '.local/cloudflare-hosted-modules');
mkdirSync(assets, { recursive: true });
mkdirSync(join(modules, 'academies'), { recursive: true });

for (const name of [
  'operations.css',
  'service-design.css',
  'service-ui.js',
  'assets',
]) {
  cpSync(join(source, name), join(assets, name), { recursive: true });
}
cpSync(
  join(root, 'src/features/makeup-schedule/academies/AC_TEST_A'),
  join(modules, 'academies/AC_TEST_A'),
  { recursive: true },
);
for (const name of ['cmaps', 'standard_fonts']) {
  cpSync(join(root, 'node_modules/pdfjs-dist', name), join(modules, name), {
    recursive: true,
  });
}
