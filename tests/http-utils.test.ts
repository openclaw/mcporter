import { describe, expect, it } from 'vitest';
import {
  looksLikeHttpUrl,
  normalizeHttpUrl,
  normalizeHttpUrlCandidate,
  splitHttpToolSelector,
} from '../src/cli/http-utils.js';

describe('normalizeHttpUrlCandidate', () => {
  it('returns undefined for missing, empty, or whitespace-only input', () => {
    expect(normalizeHttpUrlCandidate(undefined)).toBeUndefined();
    expect(normalizeHttpUrlCandidate('')).toBeUndefined();
    expect(normalizeHttpUrlCandidate('   ')).toBeUndefined();
  });

  it('promotes a bare domain-with-path to an https URL', () => {
    expect(normalizeHttpUrlCandidate('example.com/mcp')).toBe('https://example.com/mcp');
  });

  it('returns undefined for a scheme-prefixed value that is not a valid URL', () => {
    expect(normalizeHttpUrlCandidate('https://')).toBeUndefined();
  });
});

describe('looksLikeHttpUrl', () => {
  it('is false for a non-URL and true for a normalizable candidate', () => {
    expect(looksLikeHttpUrl('')).toBe(false);
    expect(looksLikeHttpUrl('example.com/mcp')).toBe(true);
  });
});

describe('normalizeHttpUrl', () => {
  it('uses URL serialization for origin and path forms', () => {
    expect(normalizeHttpUrl('HTTPS://WWW.Example.COM')).toBe('https://example.com/');
    expect(normalizeHttpUrl('https://www.example.com/mcp/')).toBe('https://example.com/mcp/');
    expect(normalizeHttpUrl('https://www.example.com/mcp')).toBe('https://example.com/mcp');
  });

  it('returns undefined for input that is not a parseable URL', () => {
    expect(normalizeHttpUrl('not a url')).toBeUndefined();
    expect(normalizeHttpUrl('')).toBeUndefined();
  });
});

describe('splitHttpToolSelector', () => {
  it('keeps the query on the server URL and drops the fragment', () => {
    expect(splitHttpToolSelector('https://example.com/a/mcp.tool?tenant=b#frag')).toEqual({
      baseUrl: 'https://example.com/a/mcp?tenant=b',
      tool: 'tool',
    });
  });

  it('lets a configured server without a fragment still match a fragment selector', () => {
    const selector = splitHttpToolSelector('https://example.com/mcp.tool#frag');
    expect(selector).not.toBeNull();
    expect(normalizeHttpUrl(selector!.baseUrl)).toBe(normalizeHttpUrl('https://example.com/mcp'));
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

  it('rejects a selector whose tool suffix has non-identifier characters', () => {
    expect(splitHttpToolSelector('https://example.com/mcp.to$ol')).toBeNull();
    expect(splitHttpToolSelector('https://example.com/mcp.a b')).toBeNull();
  });
});
