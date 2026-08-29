import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = join(projectRoot, 'desktop-runtime');
const nodeSource = process.execPath;

mkdirSync(runtimeRoot, { recursive: true });
rmSync(join(runtimeRoot, 'backend'), { recursive: true, force: true });
rmSync(join(runtimeRoot, 'automation'), { recursive: true, force: true });
cpSync(join(projectRoot, 'backend'), join(runtimeRoot, 'backend'), { recursive: true });
cpSync(join(projectRoot, 'automation'), join(runtimeRoot, 'automation'), { recursive: true });
copyFileSync(nodeSource, join(runtimeRoot, 'node'));
chmodSync(join(runtimeRoot, 'node'), 0o755);
writeFileSync(join(runtimeRoot, 'package.json'), JSON.stringify({
  name: 'instagram-agent-n8n-runtime',
  private: true,
  type: 'module',
  dependencies: {
    playwright: '1.62.0'
  }
}, null, 2));

const modulesReady = ['playwright'].every(name => {
  const modulePath = join(runtimeRoot, 'node_modules', name);
  return existsSync(join(modulePath, 'package.json')) && !lstatSync(modulePath).isSymbolicLink();
});

if (!modulesReady) {
  rmSync(join(runtimeRoot, 'node_modules'), { recursive: true, force: true });
  const install = spawnSync('pnpm', [
    'install',
    '--prod',
    '--prefer-offline',
    '--ignore-scripts',
    '--ignore-workspace',
    '--config.node-linker=hoisted'
  ], {
    cwd: runtimeRoot,
    env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
    stdio: 'inherit'
  });
  if (install.status !== 0) process.exit(install.status || 1);
}
