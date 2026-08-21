import type { ChromeDevtoolsRelayDecision } from '../chrome-devtools-relay.js';

export const DAEMON_PROTOCOL_VERSION = 2;
export const DAEMON_OPERATION_TIMEOUT_CODE = 'operation_timeout';
export const DAEMON_OAUTH_FLOW_ERROR_CODE = 'oauth_flow_error';
export const DAEMON_PROGRESS_INTERVAL_MS = 250;
export const MIN_DAEMON_PROGRESS_INTERVAL_MS = 25;

export function resolveProgressInterval(idleTimeoutMs: number): number {
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
    return DAEMON_PROGRESS_INTERVAL_MS;
  }
  return Math.min(
    DAEMON_PROGRESS_INTERVAL_MS,
    Math.max(MIN_DAEMON_PROGRESS_INTERVAL_MS, Math.floor(idleTimeoutMs / 3))
  );
}

export type DaemonRequestMethod =
  | 'callTool'
  | 'listTools'
  | 'listResources'
  | 'readResource'
  | 'closeServer'
  | 'status'
  | 'stop';

export interface DaemonRequest<T extends DaemonRequestMethod = DaemonRequestMethod, P = unknown> {
  readonly id: string;
  readonly method: T;
  readonly params: P;
  /** Protocol v2 clients opt in to progress frames by sending both fields. */
  readonly protocolVersion?: number;
  readonly progressIntervalMs?: number;
}

export interface DaemonResponse<T = unknown> {
  readonly id: string;
  readonly ok: boolean;
  readonly result?: T;
  readonly notices?: readonly string[];
  readonly error?: {
    readonly message: string;
    readonly code?: string;
  };
}

export interface DaemonProgressFrame {
  readonly type: 'progress';
  readonly id: string;
}

export type DaemonFrame<T = unknown> = DaemonProgressFrame | DaemonResponse<T>;

export function isDaemonProgressFrame(frame: DaemonFrame): frame is DaemonProgressFrame {
  return (frame as DaemonProgressFrame).type === 'progress';
}

export function encodeDaemonFrame(frame: DaemonFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

export class DaemonFrameDecoder {
  private buffer = '';
  private sawMalformedLine = false;

  push(chunk: string): DaemonFrame[] {
    this.buffer += chunk;
    const frames: DaemonFrame[] = [];
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this.collect(line, frames);
      newlineIndex = this.buffer.indexOf('\n');
    }
    return frames;
  }

  /** Flushes a final bare frame written by a protocol-v1 daemon. */
  flush(): DaemonFrame[] {
    const remainder = this.buffer;
    this.buffer = '';
    const frames: DaemonFrame[] = [];
    this.collect(remainder, frames);
    return frames;
  }

  get malformed(): boolean {
    return this.sawMalformedLine;
  }

  private collect(line: string, frames: DaemonFrame[]): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    try {
      frames.push(JSON.parse(trimmed) as DaemonFrame);
    } catch {
      this.sawMalformedLine = true;
    }
  }
}

export interface CallToolParams {
  readonly server: string;
  readonly tool: string;
  readonly args?: Record<string, unknown>;
  readonly timeoutMs?: number;
  readonly disableOAuth?: boolean;
}

export interface ListToolsParams {
  readonly server: string;
  readonly includeSchema?: boolean;
  readonly autoAuthorize?: boolean;
  readonly allowCachedAuth?: boolean;
  readonly disableOAuth?: boolean;
  readonly timeoutMs?: number;
}

export interface ListResourcesParams {
  readonly server: string;
  readonly params?: Record<string, unknown>;
  readonly allowCachedAuth?: boolean;
  readonly disableOAuth?: boolean;
}

export interface ReadResourceParams {
  readonly server: string;
  readonly uri: string;
  readonly allowCachedAuth?: boolean;
  readonly disableOAuth?: boolean;
}

export interface CloseServerParams {
  readonly server: string;
}

export interface StatusResult {
  readonly pid: number;
  /** Absent on daemons predating progress framing. */
  readonly protocolVersion?: number;
  readonly startedAt: number;
  readonly configPath: string;
  readonly configMtimeMs?: number | null;
  readonly configLayers?: Array<{
    readonly path: string;
    readonly mtimeMs: number | null;
  }>;
  readonly definitionHash?: string;
  readonly relayRuntimeIdentityVersion?: number;
  readonly relayRuntimeIdentity?: string;
  readonly relayEnvironmentKeys?: string[];
  readonly oauthNoBrowser?: boolean;
  readonly socketPath: string;
  readonly logPath?: string;
  readonly servers: Array<{
    readonly name: string;
    readonly connected: boolean;
    readonly lastUsedAt?: number;
    readonly chromeDevtoolsRelay?: ChromeDevtoolsRelayDecision;
  }>;
}
