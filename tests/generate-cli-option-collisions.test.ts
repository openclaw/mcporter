import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { generateCli } from '../src/generate-cli.js';

const execFileAsync = promisify(execFile);

it('keeps colliding flags and Commander storage keys independent in a generated CLI', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-option-keys-'));
  const fixture = path.join(directory, 'server.mjs');
  const bundle = path.join(directory, 'cli.mjs');
  const properties = Object.fromEntries(
    ['Query', 'query', 'query_2', 'query3', 'no_cache', 'nocache'].map((name) => [name, { type: 'string' }])
  );
  await fs.writeFile(
    fixture,
    `
import readline from 'node:readline';
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  if (request.method === 'initialize') {
    result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'collision', version: '1' } };
  } else if (request.method === 'tools/list') {
    result = { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: ${JSON.stringify(properties)}, required: ['Query', 'query'] } }] };
  } else {
    result = { content: [{ type: 'text', text: JSON.stringify(request.params.arguments) }] };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});
`
  );
  try {
    await generateCli({
      serverRef: JSON.stringify({ name: 'collision', command: process.execPath, args: [fixture] }),
      runtime: 'node',
      bundler: 'rolldown',
      bundle,
      timeoutMs: 5_000,
    });
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        bundle,
        'echo',
        '--query',
        'uppercase',
        '--query-4',
        'lowercase',
        '--query-2',
        'suffix',
        '--query3',
        'natural',
        '--no-cache',
        'explicit',
        '--nocache',
        'plain',
      ],
      { timeout: 10_000 }
    );
    expect(JSON.parse(stdout)).toEqual({
      Query: 'uppercase',
      query: 'lowercase',
      query_2: 'suffix',
      query3: 'natural',
      no_cache: 'explicit',
      nocache: 'plain',
    });
    const absent = await execFileAsync(
      process.execPath,
      [bundle, 'echo', '--query', 'uppercase', '--query-4', 'lowercase'],
      { timeout: 10_000 }
    );
    expect(JSON.parse(absent.stdout)).toEqual({ Query: 'uppercase', query: 'lowercase' });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 30_000);
