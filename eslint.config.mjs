import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTypeScript from 'eslint-config-next/typescript';
import prettier from 'eslint-config-prettier/flat';

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  prettier,
  globalIgnores([
    '.next/**',
    '.local/**',
    'deploy/cloudflare/.local/**',
    'deploy/cloudflare/.wrangler/**',
    'out/**',
    'android/**',
    'ios/**',
    '.husky/_/**',
    'next-env.d.ts',
  ]),
]);
