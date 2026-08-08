import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, process.argv.slice(2), {
  env: process.env,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
