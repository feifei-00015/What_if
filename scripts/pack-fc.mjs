import { mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

await mkdir('dist', { recursive: true });
await rm('dist/what-if-fc.zip', { force: true });
execFileSync('zip', ['-q', 'dist/what-if-fc.zip', 'package.json', 'backend/server.mjs', 'backend/trial-store.mjs', 'backend/prompt.mjs', 'web/generation-flow.mjs']);
console.log('Created dist/what-if-fc.zip');
