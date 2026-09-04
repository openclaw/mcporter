import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function privateFixtureDirectory(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', prefix));
}
