#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const logPath = process.env.FAKE_BUN_LOG;
if (logPath) {
  await fs.appendFile(logPath, `${JSON.stringify({ args, cwd: process.cwd() })}\n`, 'utf8');
}

if (args[0] === '--version') {
  console.log('1.2.3-fake');
  process.exit(0);
}

if (process.env.FAKE_BUN_FAIL === '1') {
  console.error('fake bun build failure');
  process.exit(1);
}

if (args[0] !== 'build') {
  console.error(`unsupported fake bun command: ${args.join(' ')}`);
  process.exit(2);
}

const outfileIndex = args.indexOf('--outfile');
const outputPath = args[outfileIndex + 1];
if (outfileIndex === -1 || !outputPath) {
  console.error('fake bun requires --outfile');
  process.exit(2);
}

await fs.mkdir(path.dirname(outputPath), { recursive: true });
const compiled = args.includes('--compile');
const content = compiled
  ? '#!/usr/bin/env node\nconsole.log("fake compiled bun artifact");\n'
  : '// fake bun bundle\nconsole.log("fake bundled artifact");\n';
await fs.writeFile(outputPath, content, 'utf8');
