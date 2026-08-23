import { describe, expect, it } from 'vitest';
import { normalizeHttpUrl, splitHttpToolSelector } from '../src/cli/http-utils.js';

describe('normalizeHttpUrl', () => {
  it('uses URL serialization for origin and path forms', () => {
    expect(normalizeHttpUrl('HTTPS://WWW.Example.COM')).toBe('https://example.com/');
    expect(normalizeHttpUrl('https://www.example.com/mcp/')).toBe('https://example.com/mcp/');
    expect(normalizeHttpUrl('https://www.example.com/mcp')).toBe('https://example.com/mcp');
  });
});

describe('splitHttpToolSelector', () => {
  it('keeps the query and fragment on the server URL', () => {
    expect(splitHttpToolSelector('https://example.com/a/mcp.tool?tenant=b#frag')).toEqual({
      baseUrl: 'https://example.com/a/mcp?tenant=b#frag',
      tool: 'tool',
    });
  });

  it('keeps the port and the encoded path segments', () => {
    expect(splitHttpToolSelector('https://example.com:8443/a%20b/mcp.tool')).toEqual({
      baseUrl: 'https://example.com:8443/a%20b/mcp',
      tool: 'tool',
    });
  });

  it('lets a configured server with a query still match the selector', () => {
    const selector = splitHttpToolSelector('https://example.com/mcp.tool?tenant=b');
    expect(selector).not.toBeNull();
    expect(normalizeHttpUrl(selector!.baseUrl)).toBe(normalizeHttpUrl('https://example.com/mcp?tenant=b'));
  });

  it('still rejects a path segment without a tool suffix', () => {
    expect(splitHttpToolSelector('https://example.com/mcp')).toBeNull();
    expect(splitHttpToolSelector('https://example.com/.tool')).toBeNull();
  });
});
