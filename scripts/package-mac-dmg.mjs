import { cpSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const appPath = join(root, 'src-tauri', 'target', 'aarch64-apple-darwin', 'release', 'bundle', 'macos', 'Instagram Agent n8n.app');
const outputPath = join(root, 'installers', 'Instagram-Agent-n8n-0.2.3-aarch64.dmg');
const staging = mkdtempSync(join(root, 'installers', 'dmg-'));

try {
  cpSync(appPath, join(staging, 'Instagram Agent n8n.app'), { recursive: true });
  symlinkSync('/Applications', join(staging, 'Applications'));
  const create = spawnSync('hdiutil', [
    'create',
    '-volname', 'Instagram Agent n8n',
    '-srcfolder', staging,
    '-ov',
    '-format', 'UDZO',
    outputPath
  ], { stdio: 'inherit' });
  if (create.status !== 0) process.exit(create.status || 1);
  const verify = spawnSync('hdiutil', ['verify', outputPath], { stdio: 'inherit' });
  if (verify.status !== 0) process.exit(verify.status || 1);
  console.log(outputPath);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
