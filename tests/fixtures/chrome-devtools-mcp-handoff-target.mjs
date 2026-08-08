import { createHash } from 'node:crypto';

const headersIndex = process.argv.indexOf('--wsHeaders');
const terminatorIndex = process.argv.indexOf('--');
let authorization;
if (headersIndex >= 0) {
  try {
    authorization = JSON.parse(process.argv[headersIndex + 1]).Authorization;
  } catch {}
}

process.stdout.write(
  JSON.stringify({
    endpoint: process.argv[2],
    hasWsHeaders: headersIndex >= 0,
    headersBeforeTerminator: terminatorIndex < 0 || headersIndex < terminatorIndex,
    authorizationDigest:
      typeof authorization === 'string' ? createHash('sha256').update(authorization).digest('hex') : null,
    handoffEnvPresent: Object.hasOwn(process.env, 'MCPORTER_CHROME_RELAY_HANDOFF_PATH'),
  })
);
