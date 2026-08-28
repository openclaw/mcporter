import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

// Every mcporter path resolves through mcporterDir(), which falls back to
// ~/.mcporter when no XDG root is set. Without this, any suite that runs the CLI
// or touches the schema cache writes into the developer's real home — we found
// hundreds of stray server directories there, next to real credentials.
//
// Suites needing finer control (see tests/helpers/isolated-test-home.ts) still
// override these; this only guarantees the default is never the real home.
// Keep the root SHORT. The daemon's unix socket lives under this home, and
// sun_path caps at ~104 bytes on macOS — long enough to overflow with the
// default $TMPDIR (/var/folders/…), which fails with EINVAL rather than a
// legible error. `/tmp` is sticky and short on POSIX; Windows has no such cap.
function shortTempBase(): string {
  if (process.platform === 'win32') return os.tmpdir();
  try {
    fs.accessSync('/tmp', fs.constants.W_OK);
    return '/tmp';
  } catch {
    return os.tmpdir();
  }
}

const root = fs.mkdtempSync(path.join(shortTempBase(), 'mcp-home-'));

process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.XDG_CONFIG_HOME = path.join(root, '.config');
process.env.XDG_DATA_HOME = path.join(root, '.local', 'share');
process.env.XDG_STATE_HOME = path.join(root, '.local', 'state');
process.env.XDG_CACHE_HOME = path.join(root, '.cache');

// tsx indexes its shared disk cache at startup. Keep fixture transforms in memory
// so unrelated projects' cache sizes cannot consume the subprocess deadlines.
process.env.TSX_DISABLE_CACHE = '1';

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
