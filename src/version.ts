import { createRequire } from 'node:module';

export const MCPORTER_VERSION = (() => {
  try {
    return createRequire(import.meta.url)('../package.json').version as string;
  } catch {
    return process.env.MCPORTER_VERSION ?? '0.0.0-dev';
  }
})();
