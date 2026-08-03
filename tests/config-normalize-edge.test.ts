import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureHttpAcceptHeader, normalizeServerEntry } from '../src/config-normalize.js';

const source = { kind: 'local' as const, path: '/tmp/mcporter.json' };

describe('server entry normalization edge behavior', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-normalize-edge-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('rejects entries without a usable transport', () => {
    expect(() => normalizeServerEntry('missing', {}, tempDir, source, [source])).toThrow(
      "Server 'missing' is missing a baseUrl/url or command definition"
    );
    expect(() => normalizeServerEntry('empty-array', { command: [] }, tempDir, source, [source])).toThrow(
      "Server 'empty-array' is missing"
    );
    expect(() => normalizeServerEntry('spaces', { command: '   ' }, tempDir, source, [source])).toThrow(
      "Server 'spaces' is missing"
    );
  });

  it('preserves command arrays and parses escaped command strings', () => {
    const array = normalizeServerEntry('array', { command: ['node', 'server.js', '--stdio'] }, tempDir, source, [
      source,
    ]);
    const escaped = normalizeServerEntry('escaped', { command: 'node "server file.js" trailing\\' }, tempDir, source, [
      source,
    ]);
    expect(array.command).toMatchObject({ command: 'node', args: ['server.js', '--stdio'] });
    expect(escaped.command).toMatchObject({ command: 'node', args: ['server file.js', 'trailing\\'] });
  });

  it('treats an existing executable path containing spaces as one command token', async () => {
    const executable = path.join(tempDir, 'server with spaces');
    await fs.writeFile(executable, '#!/bin/sh\n');

    const definition = normalizeServerEntry('path', { command: executable }, tempDir, source, [source]);

    expect(definition.command).toMatchObject({ kind: 'stdio', command: executable, args: [] });
  });

  it('normalizes unknown auth to undefined while retaining daemon logging', () => {
    const definition = normalizeServerEntry(
      'logged',
      { command: 'node', auth: 'custom', logging: { daemon: { enabled: true } } },
      tempDir,
      source,
      [source]
    );
    expect(definition.auth).toBeUndefined();
    expect(definition.logging).toEqual({ daemon: { enabled: true } });
  });

  it('repairs incomplete Accept headers without changing complete ones', () => {
    expect(ensureHttpAcceptHeader({ Accept: 'application/json' })).toEqual({
      Accept: 'application/json, text/event-stream',
    });
    expect(ensureHttpAcceptHeader({ ACCEPT: 'application/json, text/event-stream' })).toEqual({
      ACCEPT: 'application/json, text/event-stream',
    });
  });
});
