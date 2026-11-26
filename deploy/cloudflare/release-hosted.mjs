import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const branch = 'feat/homework-grading-v3';
const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const revision = git('rev-parse', 'HEAD');
const remoteHead = git(
  'ls-remote',
  '--exit-code',
  'origin',
  'refs/heads/' + branch,
).split(/\s/)[0];
if (revision !== remoteHead || git('status', '--porcelain')) {
  throw new Error(
    '기존 AXR 주소에는 origin/' +
      branch +
      '의 깨끗한 최신 커밋만 배포할 수 있습니다.',
  );
}
execFileSync(process.execPath, ['deploy/cloudflare/prepare-hosted.mjs'], {
  cwd: root,
  stdio: 'inherit',
});
execFileSync(
  process.execPath,
  [
    process.env.npm_execpath,
    'exec',
    '--yes',
    '--package=wrangler@4.163.0',
    '--',
    'wrangler',
    'deploy',
    '--minify',
    '--config',
    'deploy/cloudflare/wrangler.hosted.jsonc',
    '--keep-vars',
    '--message',
    'AXR ' + branch + ' ' + revision,
  ],
  { cwd: root, stdio: 'inherit' },
);
