import type { ChildProcess } from 'node:child_process';
import type { PassThrough } from 'node:stream';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

// Upstream TODO: Once typescript-sdk#579/#780/#1049 land, this shim can be dropped.
// We monkey-patch the transport so child processes actually exit and their stdio
// streams are destroyed; otherwise Node keeps the handles alive and mcporter hangs.

type MaybeChildProcess = ChildProcess & {
  stdio?: Array<unknown>;
};

interface ProcessStreamMeta {
  stderrChunks: string[];
  stdoutChunks?: string[];
  stdinChunks?: string[];
  command?: string;
  code?: number | null;
  flushed?: boolean;
  child?: MaybeChildProcess | null;
  transport?: object;
  listeners: Array<{
    stream: NodeJS.EventEmitter & { removeListener?: (event: string, listener: (...args: unknown[]) => void) => void };
    event: string;
    handler: (...args: unknown[]) => void;
  }>;
}

const PROCESS_BUFFERS = new WeakMap<MaybeChildProcess, ProcessStreamMeta>();
const TRANSPORT_BUFFERS = new WeakMap<object, ProcessStreamMeta>();
const STDIO_LOGS_FORCED = process.env.MCPORTER_STDIO_LOGS === '1';
const STDIO_TRACE_ENABLED = process.env.MCPORTER_STDIO_TRACE === '1';

export type StdioLogMode = 'auto' | 'always' | 'silent';

let stdioLogMode: StdioLogMode = STDIO_LOGS_FORCED ? 'always' : 'auto';

export function getStdioLogMode(): StdioLogMode {
  return stdioLogMode;
}

export function setStdioLogMode(mode: StdioLogMode): StdioLogMode {
  const previous = stdioLogMode;
  if (!STDIO_LOGS_FORCED) {
    stdioLogMode = mode;
  }
  return previous;
}

export function evaluateStdioLogPolicy(
  mode: StdioLogMode,
  hasStderr: boolean,
  exitCode: number | null | undefined
): boolean {
  if (!hasStderr) {
    return false;
  }
  if (mode === 'silent') {
    return false;
  }
  if (mode === 'always') {
    return true;
  }
  return typeof exitCode === 'number' && exitCode !== 0;
}

function shouldPrintStdioLogs(meta: ProcessStreamMeta): boolean {
  return evaluateStdioLogPolicy(stdioLogMode, meta.stderrChunks.length > 0, meta.code);
}

if (STDIO_TRACE_ENABLED) {
  console.log('[mcporter] STDIO trace logging enabled (set MCPORTER_STDIO_TRACE=0 to disable).');
}

function destroyStream(stream: unknown): void {
  if (!stream || typeof stream !== 'object') {
    return;
  }
  const emitter = stream as {
    on?: (event: string, listener: () => void) => void;
    off?: (event: string, listener: () => void) => void;
    removeListener?: (event: string, listener: () => void) => void;
    destroy?: () => void;
    end?: () => void;
    unref?: () => void;
  };
  const swallowError = () => {};
  try {
    emitter.on?.('error', swallowError);
  } catch {
    // ignore
  }
  try {
    emitter.destroy?.();
  } catch {
    // ignore
  }
  try {
    emitter.end?.();
  } catch {
    // ignore
  }
  try {
    emitter.unref?.();
  } catch {
    // ignore
  }
  try {
    emitter.off?.('error', swallowError);
  } catch {
    // ignore
  }
  try {
    emitter.removeListener?.('error', swallowError);
  } catch {
    // ignore
  }
}

function waitForChildClose(child: MaybeChildProcess | undefined, timeoutMs: number): Promise<void> {
  if (!child) {
    return Promise.resolve();
  }
  if (
    (child as { exitCode?: number | null }).exitCode !== null &&
    (child as { exitCode?: number | null }).exitCode !== undefined
  ) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const swallowProcessError = () => {};
    try {
      child.on?.('error', swallowProcessError);
    } catch {
      // ignore
    }
    const finish = (didExit: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (didExit) {
        resolve();
      } else {
        reject(new Error('timeout'));
      }
    };
    const onExit = () => finish(true);
    const onTimeout = () => finish(false);
    const cleanup = () => {
      child.removeListener('exit', onExit);
      child.removeListener('close', onExit);
      child.removeListener('error', onExit);
      try {
        child.removeListener?.('error', swallowProcessError);
      } catch {
        // ignore
      }
      if (timer) {
        clearTimeout(timer);
      }
    };
    child.once('exit', onExit);
    child.once('close', onExit);
    child.once('error', onExit);
    let timer: NodeJS.Timeout | undefined;
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(onTimeout, timeoutMs);
      timer.unref?.();
    }
  });
}

function flushProcessLogs(_child: MaybeChildProcess, meta: ProcessStreamMeta): void {
  if (meta.flushed) {
    return;
  }
  meta.flushed = true;

  if (STDIO_TRACE_ENABLED) {
    const stderrChunks = meta.stderrChunks.length;
    const stdoutChunks = meta.stdoutChunks?.length ?? 0;
    const stdinChunks = meta.stdinChunks?.length ?? 0;
    const label = meta.command ?? 'stdio server';
    console.log(
      `[mcporter] STDIO trace summary for ${label}: stdin=${stdinChunks} message(s), stdout=${stdoutChunks} chunk(s), stderr=${stderrChunks} chunk(s).`
    );
  }

  for (const { stream, event, handler } of meta.listeners) {
    try {
      stream.removeListener?.(event, handler);
    } catch {
      // ignore
    }
  }
  meta.listeners.length = 0;

  if (shouldPrintStdioLogs(meta)) {
    const heading = meta.command ? `[mcporter] stderr from ${meta.command}` : '[mcporter] stderr from stdio server';
    console.log(heading);
    process.stdout.write(meta.stderrChunks.join(''));
    if (!meta.stderrChunks[meta.stderrChunks.length - 1]?.endsWith('\n')) {
      console.log('');
    }
  }
  if (STDIO_TRACE_ENABLED && meta.stdoutChunks && meta.stdoutChunks.length > 0) {
    const heading = meta.command ? `[mcporter] stdout from ${meta.command}` : '[mcporter] stdout from stdio server';
    console.log(heading);
    process.stdout.write(meta.stdoutChunks.join(''));
    if (!meta.stdoutChunks[meta.stdoutChunks.length - 1]?.endsWith('\n')) {
      console.log('');
    }
  }
  if (STDIO_TRACE_ENABLED && meta.stdinChunks && meta.stdinChunks.length > 0) {
    const heading = meta.command ? `[mcporter] stdin to ${meta.command}` : '[mcporter] stdin to stdio server';
    console.log(heading);
    for (const entry of meta.stdinChunks) {
      console.log(entry);
    }
  }

  if (meta.child) {
    PROCESS_BUFFERS.delete(meta.child);
  }
  if (meta.transport) {
    TRANSPORT_BUFFERS.delete(meta.transport);
  }
}

function patchStdioClose(): void {
  const marker = Symbol.for('mcporter.stdio.patched');
  const proto = StdioClientTransport.prototype as unknown as Record<symbol, unknown>;
  if (proto[marker]) {
    return;
  }

  patchStdioStart();

  StdioClientTransport.prototype.close = async function patchedClose(): Promise<void> {
    const transport = this as unknown as {
      _process?: MaybeChildProcess | null;
      _stderrStream?: PassThrough | null;
      _abortController?: AbortController | null;
      _readBuffer?: { clear(): void } | null;
      onclose?: () => void;
    };
    const child = transport._process ?? null;
    const stderrStream = transport._stderrStream ?? null;
    const meta = (child ? PROCESS_BUFFERS.get(child) : undefined) ?? TRANSPORT_BUFFERS.get(transport as object);

    if (stderrStream) {
      // Ensure any piped stderr stream is torn down so no file descriptors linger.
      destroyStream(stderrStream);
      transport._stderrStream = null;
    }

    // Abort active reads/writes and clear buffered state just like the SDK does.
    transport._abortController?.abort();
    transport._abortController = null;
    transport._readBuffer?.clear?.();
    transport._readBuffer = null;

    if (!child) {
      transport.onclose?.();
      return;
    }

    // Closing stdin/stdout/stderr proactively lets Node release the handles even
    // when the child ignores SIGTERM (common with npm/npx wrappers).
    destroyStream(child.stdin);
    destroyStream(child.stdout);
    destroyStream(child.stderr);

    const stdio = Array.isArray(child.stdio) ? child.stdio : [];
    for (const stream of stdio) {
      destroyStream(stream);
    }

    let exited = await waitForChildClose(child, 700).then(
      () => true,
      () => false
    );

    if (!exited) {
      // First escalation: polite SIGTERM.
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      exited = await waitForChildClose(child, 700).then(
        () => true,
        () => false
      );
    }

    if (!exited) {
      // Final escalation: SIGKILL. If this still fails, fall through and warn.
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      await waitForChildClose(child, 500).catch(() => {});
    }

    destroyStream(child.stdin);
    destroyStream(child.stdout);
    destroyStream(child.stderr);

    const stdioAfter = Array.isArray(child.stdio) ? child.stdio : [];
    for (const stream of stdioAfter) {
      // Some transports mutate stdio in-place; run the destroy sweep again to be sure.
      destroyStream(stream);
    }

    child.unref?.();

    if (meta) {
      flushProcessLogs(meta.child ?? child, meta);
    } else if (STDIO_TRACE_ENABLED) {
      console.log('[mcporter] STDIO trace: attempted to close transport without recorded metadata.');
    }

    transport._process = null;
    transport.onclose?.();
  };

  proto[marker] = true;
}

function patchStdioStart(): void {
  const marker = Symbol.for('mcporter.stdio.startPatched');
  const proto = StdioClientTransport.prototype as unknown as Record<symbol, unknown>;
  if (proto[marker]) {
    return;
  }

  // eslint-disable-next-line @typescript-eslint/unbound-method -- capturing the original method before patching
  const originalStart: typeof StdioClientTransport.prototype.start = StdioClientTransport.prototype.start;

  StdioClientTransport.prototype.start = async function patchedStart(this: unknown): Promise<void> {
    const transport = this as unknown as {
      _serverParams?: { stderr?: string; command?: string } | undefined;
      _process?: MaybeChildProcess | null;
      _stderrStream?: PassThrough | null;
    };

    if (STDIO_TRACE_ENABLED) {
      console.log('[mcporter] STDIO trace: start() invoked for stdio transport.');
    }

    if (transport._serverParams && transport._serverParams.stderr !== 'pipe') {
      transport._serverParams = {
        ...transport._serverParams,
        stderr: 'pipe',
      };
    }

    const startPromise = originalStart.apply(this);

    const child = transport._process ?? null;
    const meta: ProcessStreamMeta = {
      stderrChunks: [],
      stdoutChunks: STDIO_TRACE_ENABLED ? [] : undefined,
      stdinChunks: STDIO_TRACE_ENABLED ? [] : undefined,
      command: transport._serverParams?.command,
      code: null,
      listeners: [],
      child,
      transport,
    };
    TRANSPORT_BUFFERS.set(transport, meta);
    if (child) {
      PROCESS_BUFFERS.set(child, meta);
      if (STDIO_TRACE_ENABLED) {
        const pid = typeof child.pid === 'number' ? child.pid : 'unknown';
        console.log(`[mcporter] STDIO trace: spawned ${meta.command ?? 'stdio server'} (pid=${pid}).`);
      }
    } else if (STDIO_TRACE_ENABLED) {
      console.log(
        `[mcporter] STDIO trace: transport for ${meta.command ?? 'stdio server'} exited before spawn listeners attached.`
      );
    }

    const targetStream = transport._stderrStream ?? child?.stderr ?? null;
    if (targetStream) {
      if (typeof (targetStream as { setEncoding?: (enc: string) => void }).setEncoding === 'function') {
        (targetStream as { setEncoding?: (enc: string) => void }).setEncoding?.('utf8');
      }
      const handleChunk = (chunk: unknown) => {
        if (typeof chunk === 'string') {
          meta.stderrChunks.push(chunk);
        } else if (Buffer.isBuffer(chunk)) {
          meta.stderrChunks.push(chunk.toString('utf8'));
        }
      };
      const swallowError = () => {};
      (targetStream as NodeJS.EventEmitter).on('data', handleChunk);
      (targetStream as NodeJS.EventEmitter).on('error', swallowError);
      meta.listeners.push({
        stream: targetStream as NodeJS.EventEmitter & {
          removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
        },
        event: 'data',
        handler: handleChunk,
      });
      meta.listeners.push({
        stream: targetStream as NodeJS.EventEmitter & {
          removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
        },
        event: 'error',
        handler: swallowError,
      });
    }

    if (STDIO_TRACE_ENABLED && child?.stdout) {
      const stdoutStream = child.stdout as NodeJS.EventEmitter & {
        removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
      };
      const handleStdout = (chunk: unknown) => {
        if (!meta.stdoutChunks) {
          meta.stdoutChunks = [];
        }
        if (typeof chunk === 'string') {
          meta.stdoutChunks.push(chunk);
        } else if (Buffer.isBuffer(chunk)) {
          meta.stdoutChunks.push(chunk.toString('utf8'));
        }
      };
      const swallowStdoutError = () => {};
      stdoutStream.on('data', handleStdout);
      stdoutStream.on('error', swallowStdoutError);
      meta.listeners.push({
        stream: stdoutStream,
        event: 'data',
        handler: handleStdout,
      });
      meta.listeners.push({
        stream: stdoutStream,
        event: 'error',
        handler: swallowStdoutError,
      });
    }

    if (child) {
      child.once('exit', (code: number | null) => {
        const entry = PROCESS_BUFFERS.get(child);
        if (entry) {
          entry.code = code;
          flushProcessLogs(child, entry);
        }
      });
    }

    await startPromise;
  };

  proto[marker] = true;
}

patchStdioClose();
patchStdioSend();

function patchStdioSend(): void {
  if (!STDIO_TRACE_ENABLED) {
    return;
  }
  const marker = Symbol.for('mcporter.stdio.sendPatched');
  const proto = StdioClientTransport.prototype as unknown as Record<symbol, unknown>;
  if (proto[marker]) {
    return;
  }

  // eslint-disable-next-line @typescript-eslint/unbound-method -- capturing the original method before patching
  const originalSend: typeof StdioClientTransport.prototype.send = StdioClientTransport.prototype.send;

  StdioClientTransport.prototype.send = function patchedSend(this: unknown, message: JSONRPCMessage): Promise<void> {
    if (STDIO_TRACE_ENABLED) {
      try {
        const transport = this as { _process?: MaybeChildProcess | null };
        const child = transport._process ?? null;
        if (child) {
          const meta = PROCESS_BUFFERS.get(child);
          if (meta) {
            if (!meta.stdinChunks) {
              meta.stdinChunks = [];
            }
            meta.stdinChunks.push(JSON.stringify(message));
          }
        }
      } catch {
        // ignore logging errors
      }
    }
    return originalSend.call(this, message);
  };

  proto[marker] = true;
}
