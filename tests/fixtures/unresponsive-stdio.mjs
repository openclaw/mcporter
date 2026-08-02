import fs from 'node:fs';

const pidFile = process.argv[2];
if (!pidFile) throw new Error('pid file argument is required');
fs.writeFileSync(pidFile, String(process.pid));
setInterval(() => {}, 1_000);
