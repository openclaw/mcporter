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
      // A ratchet, not a target. Calibrate against LINUX, where the CI coverage job
      // runs: platform-branching code makes macOS read ~1 point higher (85.1/78.3/
      // 88.9/85.2 locally vs 84.2/77.7/87.8/84.3 on ubuntu), so thresholds derived
      // from a developer machine fail CI. These sit ~1 point under the ubuntu
      // numbers; raise them deliberately when coverage climbs.
      thresholds: {
        statements: 83,
        branches: 76,
        functions: 86,
        lines: 83,
      },
    },
  },
});
