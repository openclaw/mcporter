import { describe, expect, it, vi } from 'vitest';
import { CompositePersistence, DirectoryPersistence } from '../src/oauth-persistence-stores.js';

describe('composite OAuth persistence completion', () => {
  it.each(['readSnapshot', 'saveState', 'clear'] as const)(
    'waits for sibling %s operations before reporting a failure',
    async (method) => {
      const first = new DirectoryPersistence('/unused/first');
      const second = new DirectoryPersistence('/unused/second');
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const failure = new Error('cache refused');
      vi.spyOn(first, method).mockRejectedValue(failure);
      vi.spyOn(second, method).mockImplementation(async () => {
        started.resolve();
        await release.promise;
        return {};
      });
      const persistence = new CompositePersistence([first, second]);
      const pending =
        method === 'readSnapshot'
          ? persistence.readSnapshot()
          : method === 'saveState'
            ? persistence.saveState('state')
            : persistence.clear('all');
      let finished = false;
      const outcome = pending.then(
        () => {
          finished = true;
        },
        (error: unknown) => {
          finished = true;
          return error;
        }
      );
      try {
        await started.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(finished).toBe(false);
      } finally {
        release.resolve();
        expect(await outcome).toBe(failure);
        vi.restoreAllMocks();
      }
    }
  );
});
