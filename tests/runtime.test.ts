import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadServerDefinitions } from '../src/config.js';
import { resolveEnvPlaceholders, resolveEnvValue, withEnvOverrides } from '../src/env.js';
import { resolveCommandArgument } from '../src/runtime/utils.js';

const FIXTURE_PATH = path.resolve(__dirname, 'fixtures', 'mcporter.json');

describe('loadServerDefinitions', () => {
  it('parses all Sweetistics servers', async () => {
    const servers = await loadServerDefinitions({
      configPath: FIXTURE_PATH,
      rootDir: '/repo',
    });
    expect(servers).toHaveLength(9);
    const names = servers.map((server) => server.name);
    expect(names).toContain('vercel');
    const signoz = servers.find((server) => server.name === 'signoz');
    expect(signoz).toBeDefined();
    expect(signoz?.command.kind).toBe('stdio');
    expect(signoz?.env?.SIGNOZ_URL).toBe(`\${SIGNOZ_URL:-http://localhost:3301}`);
    const vercel = servers.find((server) => server.name === 'vercel');
    const normalizedCacheDir = vercel?.tokenCacheDir ? path.normalize(vercel.tokenCacheDir) : undefined;
    expect(normalizedCacheDir).toBe(path.join(os.homedir(), '.mcporter', 'vercel'));
  });

  it('resolves HTTP headers with environment placeholders', async () => {
    process.env.LINEAR_API_KEY = 'linear-secret';
    const servers = await loadServerDefinitions({ configPath: FIXTURE_PATH });
    const linear = servers.find((server) => server.name === 'linear');
    expect(linear?.command.kind).toBe('http');
    expect(linear?.command.kind === 'http' ? linear.command.headers?.Authorization : undefined).toBe(
      `Bearer \${LINEAR_API_KEY}`
    );
  });
});

describe('environment utilities', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('resolveEnvValue respects default syntax', () => {
    expect(resolveEnvValue(`\${MISSING_VAR:-fallback}`)).toBe('fallback');
    process.env.MISSING_VAR = 'present';
    expect(resolveEnvValue(`\${MISSING_VAR:-fallback}`)).toBe('present');
  });

  it('resolveEnvPlaceholders enforces presence', () => {
    process.env.TEST_TOKEN = 'abc';
    expect(resolveEnvPlaceholders(`Bearer \${TEST_TOKEN}`)).toBe('Bearer abc');
    expect(() => resolveEnvPlaceholders(`Bearer \${NOT_SET}`)).toThrow();
  });

  it('resolveEnvPlaceholders supports embedded defaults', () => {
    delete process.env.MCPORTER_TEST_HOST;
    expect(resolveEnvPlaceholders(`https://\${MCPORTER_TEST_HOST:-example.com}/mcp`)).toBe('https://example.com/mcp');
    process.env.MCPORTER_TEST_HOST = 'api.example.test';
    expect(resolveEnvPlaceholders(`https://\${MCPORTER_TEST_HOST:-example.com}/mcp`)).toBe(
      'https://api.example.test/mcp'
    );
  });

  it('withEnvOverrides applies temporary overrides', async () => {
    delete process.env.SIGNOZ_URL;
    await withEnvOverrides({ SIGNOZ_URL: `\${SIGNOZ_URL:-http://localhost:3301}` }, async () => {
      expect(process.env.SIGNOZ_URL).toBe('http://localhost:3301');
    });
    expect(process.env.SIGNOZ_URL).toBeUndefined();
  });
});

describe('command argument interpolation', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('resolves placeholder tokens', () => {
    process.env.CHROME_DEVTOOLS_URL = 'http://127.0.0.1:5555';
    const placeholder = String.raw`\${CHROME_DEVTOOLS_URL}`;
    const result = resolveCommandArgument(`--browserUrl ${placeholder}`);
    expect(result).toBe('--browserUrl http://127.0.0.1:5555');
  });

  it('resolves placeholder fallback tokens', () => {
    delete process.env.CHROME_DEVTOOLS_URL;
    const result = resolveCommandArgument(`--browserUrl \${CHROME_DEVTOOLS_URL:-http://127.0.0.1:9222}`);
    expect(result).toBe('--browserUrl http://127.0.0.1:9222');
  });

  it('passes through tokens without placeholders', () => {
    const value = '--browserUrl';
    const result = resolveCommandArgument(value);
    expect(result).toBe(value);
  });
});
