#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFile = promisify(execFileCallback);
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 5 * 1000;
const DEFAULT_MAX_DELAY_MS = 30 * 1000;

export class NpmPublicationMismatchError extends Error {}
export class NpmPublicationTimeoutError extends Error {}

function errorText(error) {
  if (!(error instanceof Error)) return String(error);
  const details = [error.stderr, error.stdout, error.message]
    .filter((value) => typeof value === 'string' && value.trim() !== '')
    .join('\n');
  return details || error.name;
}

function isNotFound(error) {
  return /(?:\bE404\b|404 Not Found)/i.test(errorText(error));
}

function parseViewValue(stdout, spec, field) {
  const value = stdout.trim();
  if (value === '' || value === 'null' || value === 'undefined') return null;

  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = value;
  }
  if (typeof parsed !== 'string') {
    throw new Error(`npm view ${spec} ${field} returned unexpected metadata: ${value}`);
  }
  return parsed;
}

async function npmView(spec, field) {
  try {
    const { stdout } = await execFile('npm', ['view', spec, field, '--json'], {
      encoding: 'utf8',
    });
    return parseViewValue(stdout, spec, field);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw new Error(`npm view ${spec} ${field} failed: ${errorText(error)}`, { cause: error });
  }
}

function timeoutLabel(timeoutMs) {
  if (timeoutMs % 60_000 === 0) return `${timeoutMs / 60_000} minutes`;
  return `${Math.ceil(timeoutMs / 1000)} seconds`;
}

export async function verifyNpmPublication({
  packageName,
  version,
  expectedIntegrity,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
  view = npmView,
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  now = Date.now,
  log = console.log,
}) {
  if (!packageName || !version || !expectedIntegrity) {
    throw new Error('package name, version, and expected integrity are required');
  }

  const exactSpec = `${packageName}@${version}`;
  const deadline = now() + timeoutMs;
  let delayMs = initialDelayMs;
  let firstAttempt = true;

  while (true) {
    if (!firstAttempt && now() >= deadline) {
      throw new NpmPublicationTimeoutError(
        `npm did not expose ${exactSpec} with complete verified metadata within ${timeoutLabel(timeoutMs)}.`
      );
    }
    firstAttempt = false;

    const registryVersion = await view(exactSpec, 'version');
    let pending = `${exactSpec} is not visible yet`;

    if (registryVersion !== null && registryVersion !== version) {
      throw new NpmPublicationMismatchError(
        `npm returned version ${registryVersion} for ${exactSpec}; expected ${version}.`
      );
    }

    if (registryVersion === version) {
      const registryIntegrity = await view(exactSpec, 'dist.integrity');
      pending = `${exactSpec} integrity is not visible yet`;

      if (registryIntegrity !== null && registryIntegrity !== expectedIntegrity) {
        throw new NpmPublicationMismatchError(
          `npm registry integrity mismatch for ${exactSpec}: expected ${expectedIntegrity}, received ${registryIntegrity}.`
        );
      }

      if (registryIntegrity === expectedIntegrity) {
        const latest = await view(packageName, 'dist-tags.latest');
        pending = `${packageName} latest dist-tag is not visible yet`;

        if (latest !== null && latest !== version) {
          throw new NpmPublicationMismatchError(
            `npm latest dist-tag mismatch for ${packageName}: expected ${version}, received ${latest}.`
          );
        }
        if (latest === version) {
          return { version: registryVersion, integrity: registryIntegrity, latest };
        }
      }
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      throw new NpmPublicationTimeoutError(
        `npm did not expose ${exactSpec} with complete verified metadata within ${timeoutLabel(timeoutMs)}.`
      );
    }

    const waitMs = Math.min(delayMs, remainingMs);
    log(`${pending}; retrying in ${Math.ceil(waitMs / 1000)}s.`);
    await sleep(waitMs);
    delayMs = Math.min(maxDelayMs, delayMs * 2);
  }
}

async function main() {
  const [packageName, version, expectedIntegrity] = process.argv.slice(2);
  if (!packageName || !version || !expectedIntegrity) {
    console.error('Usage: verify-npm-publication.mjs <package> <version> <expected-integrity>');
    process.exitCode = 2;
    return;
  }

  await verifyNpmPublication({ packageName, version, expectedIntegrity });
  console.log(`Verified immutable npm publication ${packageName}@${version}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
