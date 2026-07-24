export const DAEMON_PROTOCOL_VERSION = 2;
export const DAEMON_OPERATION_TIMEOUT_CODE = 'operation_timeout';

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
}
