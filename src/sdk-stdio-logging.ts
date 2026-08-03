export interface ProcessStreamMeta {
  stderrChunks: string[];
  stdoutChunks?: string[];
  stdinChunks?: string[];
  command?: string;
  code?: number | null;
  flushed?: boolean;
  listeners: Array<{
    stream: NodeJS.EventEmitter & { removeListener?: (event: string, listener: (...args: unknown[]) => void) => void };
    event: string;
    handler: (...args: unknown[]) => void;
  }>;
}

const STDIO_LOGS_FORCED = process.env.MCPORTER_STDIO_LOGS === '1';
export const STDIO_TRACE_ENABLED = process.env.MCPORTER_STDIO_TRACE === '1';

export type StdioLogMode = 'auto' | 'always' | 'silent';
let stdioLogMode: StdioLogMode = STDIO_LOGS_FORCED ? 'always' : 'auto';

export function getStdioLogMode(): StdioLogMode {
  return stdioLogMode;
}
export function setStdioLogMode(mode: StdioLogMode): StdioLogMode {
  const previous = stdioLogMode;
  if (!STDIO_LOGS_FORCED) stdioLogMode = mode;
  return previous;
}
export function evaluateStdioLogPolicy(
  mode: StdioLogMode,
  hasStderr: boolean,
  exitCode: number | null | undefined
): boolean {
  if (!hasStderr || mode === 'silent') return false;
  if (mode === 'always') return true;
  return typeof exitCode === 'number' && exitCode !== 0;
}

if (STDIO_TRACE_ENABLED) {
  console.log('[mcporter] STDIO trace logging enabled (set MCPORTER_STDIO_TRACE=0 to disable).');
}

export function ignoreStdioEmitterError(): void {}

export function flushStdioLogs(meta: ProcessStreamMeta): void {
  if (meta.flushed) return;
  meta.flushed = true;
  if (STDIO_TRACE_ENABLED) {
    console.log(
      `[mcporter] STDIO trace summary for ${meta.command ?? 'stdio server'}: stdin=${meta.stdinChunks?.length ?? 0} message(s), stdout=${meta.stdoutChunks?.length ?? 0} chunk(s), stderr=${meta.stderrChunks.length} chunk(s).`
    );
  }
  for (const { stream, event, handler } of meta.listeners) {
    try {
      stream.removeListener?.(event, handler);
    } catch {}
  }
  meta.listeners.length = 0;
  if (evaluateStdioLogPolicy(stdioLogMode, meta.stderrChunks.length > 0, meta.code)) {
    console.log(meta.command ? `[mcporter] stderr from ${meta.command}` : '[mcporter] stderr from stdio server');
    process.stdout.write(meta.stderrChunks.join(''));
    if (!meta.stderrChunks.at(-1)?.endsWith('\n')) console.log('');
  }
  if (STDIO_TRACE_ENABLED && meta.stdoutChunks?.length) {
    console.log(meta.command ? `[mcporter] stdout from ${meta.command}` : '[mcporter] stdout from stdio server');
    process.stdout.write(meta.stdoutChunks.join(''));
    if (!meta.stdoutChunks.at(-1)?.endsWith('\n')) console.log('');
  }
  if (STDIO_TRACE_ENABLED && meta.stdinChunks?.length) {
    console.log(meta.command ? `[mcporter] stdin to ${meta.command}` : '[mcporter] stdin to stdio server');
    for (const entry of meta.stdinChunks) console.log(entry);
  }
}
