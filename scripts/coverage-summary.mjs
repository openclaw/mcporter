#!/usr/bin/env node
// Prints the v8 coverage totals as a Markdown table for the CI step summary.
import fs from 'node:fs';

const SUMMARY_PATH = new URL('../coverage/coverage-summary.json', import.meta.url);
const METRICS = ['statements', 'branches', 'functions', 'lines'];

const total = JSON.parse(fs.readFileSync(SUMMARY_PATH, 'utf8')).total;
const rows = METRICS.map((metric) => {
  const entry = total[metric];
  return `| ${metric} | ${entry.pct}% | ${entry.covered}/${entry.total} |`;
});

process.stdout.write(
  ['## Coverage', '', '| metric | pct | covered/total |', '| --- | --- | --- |', ...rows, ''].join('\n')
);
