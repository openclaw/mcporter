import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it.each([
  {
    name: 'keeps a fenced code block and its explanation inside a numbered item across blank lines',
    markdown:
      '1. Create a config file:\n\n   ```jsonc\n   {\n\n     "enabled": true\n   }\n   ```\n   Save the file.\n\n2. Run the CLI.\n',
    expected:
      '<ol>\n<li><p>Create a config file:</p>\n' +
      '<pre><code class="language-jsonc">{\n\n  &quot;enabled&quot;: true\n}</code></pre>\n' +
      '<p>Save the file.</p></li>\n<li>Run the CLI.</li>\n</ol>',
  },
  {
    name: 'preserves an explicit Markdown line break inside a list item',
    markdown: '- `mcporter list`  \n  Lists tools across\n  a wrapped description.\n',
    expected: '<li><code>mcporter list</code><br>\nLists tools across a wrapped description.</li>',
  },
  {
    name: 'renders wrapped list items inline while preserving nested lists and multiple paragraphs',
    markdown:
      '- One wrapped\n  paragraph.\n- A parent item:\n  - Child item.\n- First paragraph.\n\n  Second paragraph.\n',
    expected:
      '<ul>\n<li>One wrapped paragraph.</li>\n<li><p>A parent item:</p>\n<ul>\n<li>Child item.</li>\n</ul></li>\n' +
      '<li><p>First paragraph.</p>\n<p>Second paragraph.</p></li>\n</ul>',
  },
  {
    name: 'preserves bold formatting across an explicit Markdown line break',
    markdown: '**First line  \nsecond line**\n',
    expected: '<p><strong>First line<br>\nsecond line</strong></p>',
  },
])('$name', ({ markdown, expected }) => {
  const root = mkdtempSync(join(tmpdir(), 'mcporter-docs-'));
  try {
    mkdirSync(join(root, 'docs'));
    for (const page of ['index', 'quickstart', 'install']) {
      writeFileSync(join(root, 'docs', `${page}.md`), `# ${page}\n`);
    }
    writeFileSync(join(root, 'docs', 'config.md'), `# Quick Start\n\n${markdown}`);
    const script = fileURLToPath(new URL('../scripts/build-docs-site.mjs', import.meta.url));
    execFileSync(process.execPath, [script], { cwd: root });

    const html = readFileSync(join(root, 'dist', 'docs-site', 'config.html'), 'utf8');
    expect(html).toContain(expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
