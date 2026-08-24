import { describe, expect, it } from 'vitest';
import { normalizeHttpUrl } from '../src/cli/http-utils.js';

describe('normalizeHttpUrl', () => {
  it('uses URL serialization for origin and path forms', () => {
    expect(normalizeHttpUrl('HTTPS://WWW.Example.COM')).toBe('https://example.com/');
    expect(normalizeHttpUrl('https://www.example.com/mcp/')).toBe('https://example.com/mcp/');
    expect(normalizeHttpUrl('https://www.example.com/mcp')).toBe('https://example.com/mcp');
  });
});
