import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const LIVE_FLAG = process.env.MCP_LIVE_TESTS === '1';
const STREAMABLE_HTTP_URL = 'https://mcp.deepwiki.com/mcp';
const SSE_URL = 'https://mcp.deepwiki.com/sse';

const execFileAsync = promisify(execFile);

function skipReason(): string | undefined {
  if (!LIVE_FLAG) {
    return 'set MCP_LIVE_TESTS=1 to run live MCP tests';
  }
  return undefined;
}

describe.skipIf(Boolean(skipReason()))('deepwiki live', () => {
  it('lists wiki structure via streamable-http', async () => {
    const { stdout, stderr } = await execFileAsync('node', [
      'dist/cli.js',
      'call',
      STREAMABLE_HTTP_URL,
      'read_wiki_structure',
      'repoName:facebook/react',
      '--output',
      'json',
    ]);
    const normalized = stdout.trim() || stderr.trim();
    expect(normalized).toContain('Available pages for facebook/react');
    expect(normalized).toContain('Overview');
  }, 30_000);

  it('prints the readable result when default output is used via streamable-http', async () => {
    const { stdout, stderr } = await execFileAsync('node', [
      'dist/cli.js',
      'call',
      STREAMABLE_HTTP_URL,
      'read_wiki_structure',
      'repoName:facebook/react',
    ]);
    const normalized = (stdout || stderr).trim();
    expect(normalized).toContain('Available pages for facebook/react');
    expect(normalized).toContain('Overview');
    expect(normalized).not.toContain('"type"');
  }, 30_000);

  it('reports the deprecated sse endpoint as a structured 410 issue', async () => {
    const { stdout, stderr } = await execFileAsync('node', [
      'dist/cli.js',
      'call',
      SSE_URL,
      'read_wiki_structure',
      'repoName:facebook/react',
      '--output',
      'json',
    ]).catch((error: unknown) => {
      const failure = error as { stdout?: string; stderr?: string };
      return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
    });
    const normalized = stdout.trim() || stderr.trim();
    expect(normalized).toContain('"statusCode": 410');
    expect(normalized).toContain('"kind": "http"');
  }, 30_000);
});
