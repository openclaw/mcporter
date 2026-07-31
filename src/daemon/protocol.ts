export const DAEMON_PROTOCOL_VERSION = 2;
export const DAEMON_OPERATION_TIMEOUT_CODE = 'operation_timeout';

// While a request is in flight the daemon emits progress frames on the same
// socket. The client treats every frame as proof of life and restarts its idle
// deadline, so a request stays alive for as many phases as it needs -- an OAuth
// code wait plus any number of paginated `tools/list` pages -- without the
// client having to predict how many phases there will be.
export const DAEMON_PROGRESS_INTERVAL_MS = 250;
/**
 * Picks a heartbeat interval that fits inside the caller's idle deadline. A
 * fixed interval would outlive a short deadline and expire the socket before the
 * next frame arrived -- the same restart-and-replay failure the frames exist to
 * prevent -- so the cadence always tracks the deadline rather than a constant.
 *
 * There is no lower clamp on purpose: a floor would be exactly the constant that
 * overshoots the deadlines it is supposed to protect. The result is strictly
 * below the caller's deadline for every deadline above 1ms, and 1ms deadlines
 * are unachievable at any cadence.
 */
export function resolveProgressInterval(idleTimeoutMs: number): number {
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
    return DAEMON_PROGRESS_INTERVAL_MS;
  }
  return Math.min(DAEMON_PROGRESS_INTERVAL_MS, Math.max(1, Math.floor(idleTimeoutMs / 3)));
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
  // How often the caller needs proof of life, derived from its own socket
  // deadline. Absent means the daemon falls back to its default cadence.
  readonly progressIntervalMs?: number;
}

export interface DaemonResponse<T = unknown> {
  readonly id: string;
  readonly ok: boolean;
  readonly result?: T;
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

// Frames are newline-delimited JSON. `JSON.stringify` never emits a raw newline,
// so a single line always holds exactly one frame.
export function encodeDaemonFrame(frame: DaemonFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

/**
 * Incrementally splits a daemon socket stream into frames. Lines that fail to
 * parse are reported through `malformed` so callers can decide whether an
 * unreadable stream is fatal.
 */
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

  // Parses whatever is left once the stream ends. Daemons before the framed
  // protocol wrote a bare response with no trailing newline.
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
    if (trimmed.length === 0) {
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
  readonly protocolVersion: number;
  readonly startedAt: number;
  readonly configPath: string;
  readonly configMtimeMs?: number | null;
  readonly configLayers?: Array<{
    readonly path: string;
    readonly mtimeMs: number | null;
  }>;
  readonly definitionHash?: string;
  readonly socketPath: string;
  readonly logPath?: string;
  readonly servers: Array<{
    readonly name: string;
    readonly connected: boolean;
    readonly lastUsedAt?: number;
  }>;
  /**
   * Number of in-flight daemon requests when the status was answered. Absent on
   * pre-v2 daemons; clients that need to coordinate a replacement must treat
   * `undefined` as "unknown, assume busy" and wait before stopping the daemon.
   * Without this signal an upgraded client can stop a live v1 daemon mid-OAuth
   * or mid-paginated `tools/list` and force the very replay this protocol was
   * introduced to prevent.
   */
  readonly activeRequests?: number;
}
