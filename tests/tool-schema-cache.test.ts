import { describe, expect, it, vi } from 'vitest';
import { clearToolCache, getCachedTools, setCachedTools } from '../src/tool-schema-cache.js';

describe('tool-schema-cache', () => {
  it('should cache and retrieve tools', () => {
    const tools = [
      { name: 'test-tool', description: 'A test tool' },
    ];

    setCachedTools('test-server', tools);
    const cached = getCachedTools('test-server');

    expect(cached).toEqual(tools);
  });

  it('should return null for non-existent cache', () => {
    const cached = getCachedTools('non-existent-server');
    expect(cached).toBeNull();
  });

  it('should expire cache after TTL', () => {
    vi.useFakeTimers();

    const tools = [{ name: 'test-tool' }];
    setCachedTools('test-server', tools);

    // Should be cached immediately
    expect(getCachedTools('test-server')).toEqual(tools);

    // Advance time past TTL (60 seconds)
    vi.advanceTimersByTime(61_000);

    // Should be expired
    expect(getCachedTools('test-server')).toBeNull();

    vi.useRealTimers();
  });

  it('should clear specific server cache', () => {
    const tools1 = [{ name: 'tool1' }];
    const tools2 = [{ name: 'tool2' }];

    setCachedTools('server1', tools1);
    setCachedTools('server2', tools2);

    clearToolCache('server1');

    expect(getCachedTools('server1')).toBeNull();
    expect(getCachedTools('server2')).toEqual(tools2);
  });

  it('should clear all caches', () => {
    setCachedTools('server1', [{ name: 'tool1' }]);
    setCachedTools('server2', [{ name: 'tool2' }]);

    clearToolCache();

    expect(getCachedTools('server1')).toBeNull();
    expect(getCachedTools('server2')).toBeNull();
  });
});
