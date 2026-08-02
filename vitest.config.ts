import { defineConfig } from 'vitest/config';

const quietReporterEnabled = process.env.MCPORTER_TEST_REPORTER === 'quiet';

const quietReporterOptions = quietReporterEnabled
  ? {
      reporters: ['dot'],
      silent: 'passed-only' as const,
    }
  : {};

export default defineConfig({
  test: {
    // Quiet mode hides console output for passing tests so CLI fixture logs
    // (e.g., the full `mcporter list` banners) don't overwhelm the reporter.
    ...quietReporterOptions,
    // CLI-heavy suites import the full entrypoint in parallel and can exceed the
    // default 5s timeout under local load even when behavior is correct.
    testTimeout: 10_000,
    // Agent worktrees under .claude/worktrees contain full repo copies; without
    // this exclude a root-level run also collects every worktree's test suite.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        // Re-export barrel and generated schema output carry no branches worth covering.
        'src/index.ts',
        'src/**/*.d.ts',
      ],
      reporter: ['text-summary', 'json-summary', 'lcov'],
      // A ratchet, not a target: these sit ~1 point under the measured coverage
      // (85.0 st / 78.2 br / 88.9 fn / 85.1 li) so an unrelated PR cannot trip CI
      // by a rounding error, while a real regression still fails. Raise them
      // deliberately when coverage climbs.
      thresholds: {
        statements: 84,
        branches: 77,
        functions: 88,
        lines: 84,
      },
    },
  },
});
