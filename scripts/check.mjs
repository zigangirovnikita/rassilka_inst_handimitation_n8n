import { spawnSync } from 'node:child_process';

const files = [
  'backend/server.js',
  'backend/storage.js',
  'backend/profileStore.js',
  'backend/n8nExecutorStore.js',
  'automation/instagramWorker.js',
  'automation/n8nExecutorResponse.js',
  'automation/n8nExecutorWorker.js',
  'frontend/src/api.js'
];

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log('Syntax check passed');
