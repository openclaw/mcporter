// Here we test only `toFileUrl` from `src/config-imports.ts` as
// `pathsForImport` and `readExternalEntries` should be tested for
// their corresponding source code files

import { describe, expect, it } from 'vitest';
import * as __testedFile from '../src/config-imports';

describe('src/config-imports.ts', () => {
  describe('toFileUrl', () => {
    const { toFileUrl } = __testedFile;
    // filePath: string

    it('should test toFileUrl( mock-parameters.filePath 1 )', () => {
      const filePath: Parameters<typeof toFileUrl>[0] = '/foo#1';
      const __expectedResult: ReturnType<typeof toFileUrl> = 'file:///foo%231' as any;
      expect(toFileUrl(filePath).href).toEqual(__expectedResult);
    });

    it('should test toFileUrl( mock-parameters.filePath 2 )', () => {
      const filePath: Parameters<typeof toFileUrl>[0] = '/foo';
      const __expectedResult: ReturnType<typeof toFileUrl> = 'file:///foo' as any;
      expect(toFileUrl(filePath).href).toEqual(__expectedResult);
    });

    it('should test toFileUrl( mock-parameters.filePath 3 )', () => {
      const filePath: Parameters<typeof toFileUrl>[0] = '/some/path%.c';
      const __expectedResult: ReturnType<typeof toFileUrl> = 'file:///some/path%25.c' as any;
      expect(toFileUrl(filePath).href).toEqual(__expectedResult);
    });
  });
});

// 3TG (https://3tg.dev) created 3 tests in 2871 ms (957.000 ms per generated test) @ 2026-03-16T13:17:32.520Z
