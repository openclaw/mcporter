import type { JSONRPCMessage } from '@modelcontextprotocol/client';
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/client/stdio';
import {
  flushStdioLogs,
  ignoreStdioEmitterError,
  STDIO_TRACE_ENABLED,
  type ProcessStreamMeta,
} from '../sdk-stdio-logging.js';

export interface McporterStdioTransportParameters extends StdioServerParameters {
  readonly redactDiagnostics?: boolean;
  readonly cleanup?: () => Promise<void> | void;
}

/**
 * MCPorter's stdio transport keeps stderr diagnostics and optional trace data
 * without reaching into SDK internals. As a subclass it also makes v2's
 * version-negotiation probe run in place, avoiding a disposable sibling spawn.
 */
export class McporterStdioTransport extends StdioClientTransport {
  private readonly meta: ProcessStreamMeta;
  private closing = false;
  private closeDelegate: (() => void) | undefined;
  private messageDelegate: ((message: JSONRPCMessage) => void) | undefined;
  private readonly closeInterceptor = () => {
    this.meta.code = this.closing ? 0 : 1;
    flushStdioLogs(this.meta);
    void this.cleanup();
    this.closeDelegate?.();
  };
  private readonly messageInterceptor = (message: JSONRPCMessage) => {
    if (STDIO_TRACE_ENABLED && !this.parameters.redactDiagnostics)
      this.meta.stdoutChunks?.push(JSON.stringify(message));
    this.messageDelegate?.(message);
  };

  private cleanupPromise: Promise<void> | undefined;

  constructor(private readonly parameters: McporterStdioTransportParameters) {
    super({ ...parameters, stderr: 'pipe' });
    this.meta = {
      stderrChunks: [],
      stdoutChunks: STDIO_TRACE_ENABLED ? [] : undefined,
      stdinChunks: STDIO_TRACE_ENABLED ? [] : undefined,
      command: parameters.command,
      code: null,
      listeners: [],
    };

    const stderr = this.stderr;
    if (stderr) {
      (stderr as { setEncoding?: (encoding: string) => void }).setEncoding?.('utf8');
      const handleChunk = (chunk: unknown) => {
        if (!this.parameters.redactDiagnostics)
          this.meta.stderrChunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      };
      stderr.on('data', handleChunk);
      stderr.on('error', ignoreStdioEmitterError);
      this.meta.listeners.push(
        { stream: stderr, event: 'data', handler: handleChunk },
        { stream: stderr, event: 'error', handler: ignoreStdioEmitterError }
      );
    }
  }

  override async start(): Promise<void> {
    if (STDIO_TRACE_ENABLED && !this.parameters.redactDiagnostics)
      console.log('[mcporter] STDIO trace: start() invoked for stdio transport.');
    this.installInterceptors();
    await super.start();
    if (STDIO_TRACE_ENABLED && !this.parameters.redactDiagnostics) {
      console.log(
        `[mcporter] STDIO trace: spawned ${this.meta.command ?? 'stdio server'} (pid=${this.pid ?? 'unknown'}).`
      );
    }
  }

  override async send(message: JSONRPCMessage): Promise<void> {
    // The negotiation probe temporarily owns these public callbacks and then
    // restores them. Reinstall before every send so the live post-probe
    // connection retains logging without patching SDK internals.
    this.installInterceptors();
    if (STDIO_TRACE_ENABLED && !this.parameters.redactDiagnostics) this.meta.stdinChunks?.push(JSON.stringify(message));
    await super.send(message);
  }

  override async close(): Promise<void> {
    this.closing = true;
    this.installInterceptors();
    try {
      await super.close();
    } finally {
      this.meta.code ??= 0;
      flushStdioLogs(this.meta);
      await this.cleanup();
    }
  }

  private cleanup(): Promise<void> {
    this.cleanupPromise ??= Promise.resolve(this.parameters.cleanup?.()).catch(() => {});
    return this.cleanupPromise;
  }

  private installInterceptors(): void {
    if (this.onclose !== this.closeInterceptor) {
      this.closeDelegate = this.onclose;
      this.onclose = this.closeInterceptor;
    }
    if (this.onmessage !== this.messageInterceptor) {
      this.messageDelegate = this.onmessage;
      this.onmessage = this.messageInterceptor;
    }
  }
}
