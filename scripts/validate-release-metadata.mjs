#!/usr/bin/env node

import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const expectedAuthor = 'OpenClaw';
const expectedRepoUrl = 'https://github.com/openclaw/mcporter';
const normalizeRepoUrl = (value) =>
  String(value ?? '')
    .trim()
    .replace(/^git\+/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
const actualRepoUrl = normalizeRepoUrl(pkg?.repository?.url);
const normalizedExpectedRepoUrl = normalizeRepoUrl(expectedRepoUrl);
const errors = [];

if (actualRepoUrl !== normalizedExpectedRepoUrl) {
  errors.push(
    `package.json repository.url must resolve to ${normalizedExpectedRepoUrl}; found ${actualRepoUrl || '<missing>'}`
  );
}
if ((pkg?.author ?? '') !== expectedAuthor) {
  errors.push(`package.json author must be exactly "${expectedAuthor}"; found "${pkg?.author ?? ''}"`);
}
if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exit(1);
}

console.log('Package metadata validated.');
