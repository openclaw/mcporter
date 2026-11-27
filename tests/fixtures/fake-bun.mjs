#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const logPath = process.env.FAKE_BUN_LOG;
if (logPath) {
  await fs.appendFile(logPath, `${JSON.stringify({ args, cwd: process.cwd() })}\n`, 'utf8');
}

if (args[0] === '--version') {
  console.log(process.env.FAKE_BUN_VERSION ?? '1.4.4');
  process.exit(0);
}

if (args.includes('--print')) {
  console.log(
    JSON.stringify({ version: process.env.FAKE_BUN_VERSION ?? '1.4.4', executable: fileURLToPath(import.meta.url) })
  );
  process.exit(0);
}

if (args.length === 1 && args[0].endsWith('build.mjs')) {
  const driver = await fs.readFile(args[0], 'utf8');
  const entry = JSON.parse(/entrypoints:\[("(?:[^"\\]|\\.)*")\]/.exec(driver)[1]);
  const directory = JSON.parse(/outdir:("(?:[^"\\]|\\.)*")/.exec(driver)[1]);
  const name = JSON.parse(/naming:("(?:[^"\\]|\\.)*")/.exec(driver)[1]);
  const target = JSON.parse(/target:("(?:[^"\\]|\\.)*")/.exec(driver)[1]);
  const minify = /minify:true/.test(driver);
  args.splice(
    0,
    args.length,
    'build',
    entry,
    '--outfile',
    path.join(directory, name),
    '--target',
    target,
    ...(minify ? ['--minify'] : [])
  );
  if (logPath) await fs.appendFile(logPath, `${JSON.stringify({ args, cwd: process.cwd() })}\n`, 'utf8');
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
