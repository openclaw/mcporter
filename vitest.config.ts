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
    // Point HOME/XDG at a throwaway root before any suite loads, so no test can
    // write into a developer's real ~/.mcporter.
    setupFiles: ['./tests/setup/isolate-home.ts'],
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
      // A ratchet, not a target. Calibrate against LINUX, where the CI coverage job
      // runs: the prior macOS-to-ubuntu deltas were 0.85/0.50/1.08/0.88 points.
      // Current macOS coverage is 91.5/84.5/92.7/91.7, projecting to roughly
      // 90.6/84.0/91.6/90.8 on ubuntu. These thresholds sit about 1 point below
      // that projection; raise them deliberately when coverage climbs.
      thresholds: {
        statements: 89.6,
        branches: 83.0,
        functions: 90.6,
        lines: 89.8,
      },
    },
  },
});
