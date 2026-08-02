import type { PassThrough } from 'node:stream';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import {
  flushProcessLogs,
  getProcessStreamMeta,
  getTransportStreamMeta,
  ignoreStdioEmitterError,
  registerProcessStreamMeta,
  STDIO_TRACE_ENABLED,
  type ProcessStreamMeta,
} from './sdk-stdio-logging.js';
import { closeStdioChild, destroyStream, type MaybeChildProcess } from './sdk-stdio-process.js';

export { evaluateStdioLogPolicy, getStdioLogMode, setStdioLogMode, type StdioLogMode } from './sdk-stdio-logging.js';

// Upstream TODO: Once typescript-sdk#579/#780/#1049 land, this shim can be dropped.
// We monkey-patch the transport so child processes actually exit and their stdio
// streams are destroyed; otherwise Node keeps the handles alive and mcporter hangs.

async function patchedStdioClose(this: StdioClientTransport): Promise<void> {
  const transport = this as unknown as {
    _process?: MaybeChildProcess | null;
    _stderrStream?: PassThrough | null;
    _abortController?: AbortController | null;
    _readBuffer?: { clear(): void } | null;
    onclose?: () => void;
  };
  const child = transport._process ?? null;
  const meta = (child ? getProcessStreamMeta(child) : undefined) ?? getTransportStreamMeta(transport);
  if (transport._stderrStream) {
    destroyStream(transport._stderrStream);
    transport._stderrStream = null;
  }
  transport._abortController?.abort();
  transport._abortController = null;
  transport._readBuffer?.clear?.();
  transport._readBuffer = null;
  if (!child) {
    transport.onclose?.();
    return;
  }
  await closeStdioChild(child);
  if (meta) {
    flushProcessLogs(meta.child ?? child, meta);
  } else if (STDIO_TRACE_ENABLED) {
    console.log('[mcporter] STDIO trace: attempted to close transport without recorded metadata.');
  }
  transport._process = null;
  transport.onclose?.();
}

function patchStdioClose(): void {
  const marker = Symbol.for('mcporter.stdio.patched');
  const proto = StdioClientTransport.prototype as unknown as Record<symbol, unknown>;
  if (proto[marker]) return;
  patchStdioStart();
  StdioClientTransport.prototype.close = patchedStdioClose;
  proto[marker] = true;
}

function patchStdioStart(): void {
  const marker = Symbol.for('mcporter.stdio.startPatched');
  const proto = StdioClientTransport.prototype as unknown as Record<symbol, unknown>;
  if (proto[marker]) return;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- capturing the original method before patching
  const originalStart: typeof StdioClientTransport.prototype.start = StdioClientTransport.prototype.start;

  StdioClientTransport.prototype.start = async function patchedStart(this: unknown): Promise<void> {
    const transport = this as unknown as {
      _serverParams?: { stderr?: string; command?: string };
      _process?: MaybeChildProcess | null;
      _stderrStream?: PassThrough | null;
    };
    if (STDIO_TRACE_ENABLED) console.log('[mcporter] STDIO trace: start() invoked for stdio transport.');
    if (transport._serverParams && transport._serverParams.stderr !== 'pipe') {
      transport._serverParams = { ...transport._serverParams, stderr: 'pipe' };
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
    registerProcessStreamMeta(meta);
    if (child && STDIO_TRACE_ENABLED) {
      console.log(`[mcporter] STDIO trace: spawned ${meta.command ?? 'stdio server'} (pid=${child.pid ?? 'unknown'}).`);
    } else if (!child && STDIO_TRACE_ENABLED) {
      console.log(
        `[mcporter] STDIO trace: transport for ${meta.command ?? 'stdio server'} exited before spawn listeners attached.`
      );
    }
    const targetStream = transport._stderrStream ?? child?.stderr ?? null;
    if (targetStream) {
      (targetStream as { setEncoding?: (encoding: string) => void }).setEncoding?.('utf8');
      const handleChunk = (chunk: unknown) => {
        if (typeof chunk === 'string') meta.stderrChunks.push(chunk);
        else if (Buffer.isBuffer(chunk)) meta.stderrChunks.push(chunk.toString('utf8'));
      };
      targetStream.on('data', handleChunk);
      targetStream.on('error', ignoreStdioEmitterError);
      meta.listeners.push(
        { stream: targetStream, event: 'data', handler: handleChunk },
        { stream: targetStream, event: 'error', handler: ignoreStdioEmitterError }
      );
    }
    if (STDIO_TRACE_ENABLED && child?.stdout) {
      const handleStdout = (chunk: unknown) => {
        meta.stdoutChunks ??= [];
        if (typeof chunk === 'string') meta.stdoutChunks.push(chunk);
        else if (Buffer.isBuffer(chunk)) meta.stdoutChunks.push(chunk.toString('utf8'));
      };
      child.stdout.on('data', handleStdout);
      child.stdout.on('error', ignoreStdioEmitterError);
      meta.listeners.push(
        { stream: child.stdout, event: 'data', handler: handleStdout },
        { stream: child.stdout, event: 'error', handler: ignoreStdioEmitterError }
      );
    }
    if (child) {
      child.once('exit', (code: number | null) => {
        const entry = getProcessStreamMeta(child);
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

function patchStdioSend(): void {
  if (!STDIO_TRACE_ENABLED) return;
  const marker = Symbol.for('mcporter.stdio.sendPatched');
  const proto = StdioClientTransport.prototype as unknown as Record<symbol, unknown>;
  if (proto[marker]) return;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- capturing the original method before patching
  const originalSend: typeof StdioClientTransport.prototype.send = StdioClientTransport.prototype.send;
  StdioClientTransport.prototype.send = function patchedSend(this: unknown, message: JSONRPCMessage): Promise<void> {
    try {
      const child = (this as { _process?: MaybeChildProcess | null })._process ?? null;
      const meta = child ? getProcessStreamMeta(child) : undefined;
      if (meta) {
        meta.stdinChunks ??= [];
        meta.stdinChunks.push(JSON.stringify(message));
      }
    } catch {}
    return originalSend.call(this, message);
  };
  proto[marker] = true;
}

patchStdioClose();
patchStdioSend();
