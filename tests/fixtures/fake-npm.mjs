#!/usr/bin/env node

import fs from 'node:fs/promises';

const logPath = process.env.FAKE_NPM_LOG;
if (logPath) {
  await fs.appendFile(logPath, `${JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() })}\n`, 'utf8');
}

if (process.env.FAKE_NPM_FAIL === '1') {
  console.error('fake npm install failure');
  process.exit(1);
}
