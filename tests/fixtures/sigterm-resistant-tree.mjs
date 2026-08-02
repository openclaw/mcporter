import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2];
if (mode === 'descendant') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1_000);
} else {
  const pidFile = process.argv[2];
  if (!pidFile) throw new Error('pid file argument is required');
  process.on('SIGTERM', () => {});
  const descendant = spawn(process.execPath, [fileURLToPath(import.meta.url), 'descendant'], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  fs.writeFileSync(pidFile, String(descendant.pid));
  setInterval(() => {}, 1_000);
}
