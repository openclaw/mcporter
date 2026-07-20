import { describe, expect, it } from 'vitest';
import { nodeHttp1Fetch } from '../src/runtime/node-http-fetch.js';
import { resolveHttpFetchOverride } from '../src/runtime/transport.js';
import type { ServerDefinition } from '../src/config-schema.js';

function httpServer(url: string, httpFetch?: ServerDefinition['httpFetch']): ServerDefinition {
  return {
    name: 'test',
    command: { kind: 'http', url: new URL(url) },
    ...(httpFetch ? { httpFetch } : {}),
  } as ServerDefinition;
}

describe('resolveHttpFetchOverride', () => {
  it('opts known-bad hosts into node-http1 without configuration', () => {
    // These servers hold the standalone GET SSE stream open while emitting nothing,
    // which stalls every later same-origin request under undici's shared pool.
    expect(resolveHttpFetchOverride(httpServer('https://mcp.paddle.com/mcp'))).toBe(nodeHttp1Fetch);
    expect(resolveHttpFetchOverride(httpServer('https://api.sunsama.com/mcp'))).toBe(nodeHttp1Fetch);
  });

  it('matches known hosts case-insensitively', () => {
    expect(resolveHttpFetchOverride(httpServer('https://MCP.PADDLE.COM/mcp'))).toBe(nodeHttp1Fetch);
  });

  it('does not match unrelated hosts or subdomain lookalikes', () => {
    expect(resolveHttpFetchOverride(httpServer('https://example.com/mcp'))).toBeUndefined();
    expect(resolveHttpFetchOverride(httpServer('https://mcp.paddle.com.evil.test/mcp'))).toBeUndefined();
  });

  it('honours an explicit httpFetch setting over the host list', () => {
    expect(resolveHttpFetchOverride(httpServer('https://mcp.paddle.com/mcp', 'default'))).toBeUndefined();
    expect(resolveHttpFetchOverride(httpServer('https://example.com/mcp', 'node-http1'))).toBe(nodeHttp1Fetch);
  });

  it('ignores stdio servers', () => {
    const stdio = {
      name: 'test',
      command: { kind: 'stdio', command: 'foo', args: [], cwd: '/tmp' },
    } as ServerDefinition;
    expect(resolveHttpFetchOverride(stdio)).toBeUndefined();
  });
});
