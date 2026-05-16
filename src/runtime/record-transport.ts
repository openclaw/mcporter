import fs from 'node:fs/promises';
import path from 'node:path';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import { legacyMcporterDir } from '../paths.js';

export interface RecordTransportOptions {
  readonly inner: Transport;
  readonly recordPath: string;
  readonly server: string;
}

export interface RecordingMeta {
  readonly dir: 'send' | 'recv' | 'lifecycle';
  readonly server: string;
  readonly ts: string;
}

export type RecordedMessage = JSONRPCMessage & {
  readonly _meta?: RecordingMeta;
};

export class RecordTransport implements Transport {
  onclose?: Transport['onclose'];
  onerror?: Transport['onerror'];
  onmessage?: Transport['onmessage'];
  sessionId?: string;
  finishAuth?: (authorizationCode: string) => Promise<void>;

  private writes: Promise<void> = Promise.resolve();
  private closeRecorded = false;

  constructor(private readonly opts: RecordTransportOptions) {
    this.sessionId = opts.inner.sessionId;
    const finishAuth = (opts.inner as { finishAuth?: (authorizationCode: string) => Promise<void> }).finishAuth;
    if (finishAuth) {
      this.finishAuth = (authorizationCode) => finishAuth.call(opts.inner, authorizationCode);
    }
  }

  async start(): Promise<void> {
    this.opts.inner.onclose = () => {
      void this.appendCloseOnce();
      this.onclose?.();
    };
    this.opts.inner.onerror = (error) => {
      this.onerror?.(error);
    };
    this.opts.inner.onmessage = (message) => {
      void this.appendLine(this.withMeta(message, 'recv'));
      this.onmessage?.(message);
    };
    await this.appendLifecycle('start');
    await this.opts.inner.start();
    this.sessionId = this.opts.inner.sessionId;
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    await this.appendLine(this.withMeta(message, 'send'));
    await this.opts.inner.send(message, options);
  }

  async close(): Promise<void> {
    await this.appendCloseOnce();
    await this.opts.inner.close();
    await this.writes;
  }

  setProtocolVersion(version: string): void {
    this.opts.inner.setProtocolVersion?.(version);
  }

  private async appendLifecycle(event: 'start' | 'close'): Promise<void> {
    await this.appendLine(
      this.withMeta(
        {
          jsonrpc: '2.0',
          method: `$transport/${event}`,
        },
        'lifecycle'
      )
    );
  }

  private async appendCloseOnce(): Promise<void> {
    if (this.closeRecorded) {
      return;
    }
    this.closeRecorded = true;
    await this.appendLifecycle('close');
  }

  private withMeta(message: JSONRPCMessage, dir: RecordingMeta['dir']): RecordedMessage {
    return {
      ...message,
      _meta: {
        dir,
        server: this.opts.server,
        ts: new Date().toISOString(),
      },
    };
  }

  private async appendLine(message: RecordedMessage): Promise<void> {
    await fs.mkdir(path.dirname(this.opts.recordPath), { recursive: true });
    const line = `${JSON.stringify(message)}\n`;
    this.writes = this.writes.then(() => fs.appendFile(this.opts.recordPath, line, 'utf8'));
    await this.writes;
  }
}

export function resolveRecordingPath(sessionName: string): string {
  const normalized = normalizeRecordingSessionName(sessionName);
  return path.join(legacyMcporterDir(), 'recordings', `${normalized}.ndjson`);
}

export function resolveRecordingConfigPath(sessionName: string): string {
  const normalized = normalizeRecordingSessionName(sessionName);
  return path.join(legacyMcporterDir(), 'recordings', `${normalized}.config.json`);
}

export function normalizeRecordingSessionName(sessionName: string): string {
  const normalized = sessionName.trim();
  if (!normalized) {
    throw new Error('Recording session name is required.');
  }
  if (normalized.includes('/') || normalized.includes('\\') || normalized === '.' || normalized === '..') {
    throw new Error(`Invalid recording session name '${sessionName}'. Use a simple file name without path separators.`);
  }
  return normalized;
}
