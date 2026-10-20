import { mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

await mkdir('dist', { recursive: true });
await rm('dist/what-if-fc.zip', { force: true });
execFileSync('zip', ['-q', '-r', 'dist/what-if-fc.zip', 'package.json', 'package-lock.json',
  'backend/server.mjs', 'backend/trial-store.mjs', 'backend/tablestore-state.mjs',
  'backend/model-network.mjs', 'backend/prompt.mjs',
  'web/generation-flow.mjs', 'node_modules']);
console.log('Created dist/what-if-fc.zip');
