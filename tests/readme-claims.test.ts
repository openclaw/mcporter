import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('README protocol claims', () => {
  it('describes legacy compatibility without claiming byte-identical handshakes', async () => {
    const readme = await fs.readFile(path.join(REPO_ROOT, 'README.md'), 'utf8');

    expect(readme).not.toContain('classic `initialize` handshake, byte-identical to before');
    expect(readme).toContain('client elicitation capabilities');
  });

  it('distinguishes representative CI coverage from the full fixture surface', async () => {
    const readme = await fs.readFile(path.join(REPO_ROOT, 'README.md'), 'utf8');

    expect(readme).not.toContain('exercising the wide surface of each protocol generation end-to-end in CI');
    expect(readme).toContain('representative fixture paths end-to-end');
  });
});
