// Shared platform scaling for test timing budgets.
//
// Windows CI runners are roughly 3-4x slower than macOS/Linux for this suite
// (the same tests run ~25s locally and ~100s on a Windows runner), mostly due
// to process-spawn and process-tree enumeration cost. Budgets that exist to
// catch hangs — rather than to measure machine speed — should be expressed via
// `budget()` so they scale by platform instead of being tuned one flake at a
// time. Assertions that genuinely police real-time behavior (e.g. "close
// settles promptly") should NOT use this helper; keep those fixed and document
// them as real-time checks.
export const CI_SLOWDOWN = process.platform === 'win32' ? 3 : 1;

// Scale a millisecond budget that guards against hangs, so slow platforms get
// proportionally more headroom. Pass the value you would use on a fast machine.
export function budget(ms: number): number {
  return ms * CI_SLOWDOWN;
}
