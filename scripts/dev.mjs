import { spawn } from 'node:child_process';

const processes = [
  spawn('pnpm', ['dev:backend'], { stdio: 'inherit' }),
  spawn('pnpm', ['dev:frontend'], { stdio: 'inherit' })
];

function stopAll(signal) {
  for (const child of processes) child.kill(signal);
}

process.on('SIGINT', () => {
  stopAll('SIGINT');
  process.exit(130);
});

process.on('SIGTERM', () => {
  stopAll('SIGTERM');
  process.exit(143);
});

for (const child of processes) {
  child.on('exit', code => {
    stopAll('SIGTERM');
    process.exit(code || 0);
  });
}
