import { z } from 'zod';

export const ImportKindSchema = z
  .enum(['cursor', 'claude-code', 'claude-desktop', 'codex', 'windsurf', 'opencode', 'vscode'])
  .describe('Supported editor/client configurations to import MCP servers from');

export type ImportKind = z.infer<typeof ImportKindSchema>;

export const DEFAULT_IMPORTS: ImportKind[] = [
  'cursor',
  'claude-code',
  'claude-desktop',
  'codex',
  'windsurf',
  'opencode',
  'vscode',
];

const RawLifecycleSchema = z
  .union([
    z.literal('keep-alive').describe('Keep the server connection alive'),
    z.literal('ephemeral').describe('Connect only when needed'),
    z.object({
      mode: z.union([z.literal('keep-alive'), z.literal('ephemeral')]).describe('Connection lifecycle mode'),
      idleTimeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Idle timeout in milliseconds before disconnecting'),
    }),
  ])
  .describe('Server connection lifecycle: keep-alive maintains persistent connections, ephemeral connects on-demand');

export type RawLifecycle = z.infer<typeof RawLifecycleSchema>;

const ToolNamesSchema = z.array(z.string()).describe('Exact MCP tool names');

const RawLoggingSchema = z
  .object({
    daemon: z
      .object({
        enabled: z.boolean().optional().describe('Enable daemon logging for this server'),
      })
      .optional()
      .describe('Daemon-specific logging configuration'),
  })
  .optional()
  .describe('Logging configuration for the server');

export const RawEntrySchema = z
  .object({
    description: z.string().optional().describe('Human-readable description of the server'),
    baseUrl: z.string().optional().describe('Base URL for HTTP/SSE transport (camelCase)'),
    base_url: z.string().optional().describe('Base URL for HTTP/SSE transport (snake_case)'),
    url: z.string().optional().describe('Server URL for HTTP/SSE transport'),
    serverUrl: z.string().optional().describe('Server URL for HTTP/SSE transport (camelCase)'),
    server_url: z.string().optional().describe('Server URL for HTTP/SSE transport (snake_case)'),
    command: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe('Command to spawn for stdio transport (string or array of arguments)'),
    executable: z.string().optional().describe('Executable path for stdio transport'),
    args: z.array(z.string()).optional().describe('Arguments to pass to the stdio command'),
    cwd: z
      .string()
      .optional()
      .describe(
        'Working directory for stdio servers. A leading ~ is expanded to $HOME; relative paths resolve against the config file directory. All paths are normalized for the host platform'
      ),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .describe('HTTP headers for requests. Supports $VAR and $env:VAR placeholders'),
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe('Environment variables for stdio commands. Supports $VAR and fallback syntax'),
    auth: z.string().optional().describe('Authentication method (e.g., "oauth")'),
    tokenCacheDir: z.string().optional().describe('Directory for caching OAuth tokens (camelCase)'),
    token_cache_dir: z.string().optional().describe('Directory for caching OAuth tokens (snake_case)'),
    clientName: z.string().optional().describe('Client identifier for server telemetry (camelCase)'),
    client_name: z.string().optional().describe('Client identifier for server telemetry (snake_case)'),
    oauthRedirectUrl: z.string().optional().describe('Custom OAuth redirect URL (camelCase)'),
    oauth_redirect_url: z.string().optional().describe('Custom OAuth redirect URL (snake_case)'),
    oauthScope: z.string().optional().describe('OAuth scope override (camelCase)'),
    oauth_scope: z.string().optional().describe('OAuth scope override (snake_case)'),
    oauthCommand: z
      .object({
        args: z.array(z.string()).describe('Arguments for the OAuth command'),
      })
      .optional()
      .describe('Custom OAuth command configuration for stdio servers (camelCase)'),
    oauth_command: z
      .object({
        args: z.array(z.string()).describe('Arguments for the OAuth command'),
      })
      .optional()
      .describe('Custom OAuth command configuration for stdio servers (snake_case)'),
    bearerToken: z.string().optional().describe('Static bearer token for authentication (camelCase)'),
    bearer_token: z.string().optional().describe('Static bearer token for authentication (snake_case)'),
    bearerTokenEnv: z.string().optional().describe('Environment variable name containing the bearer token (camelCase)'),
    bearer_token_env: z
      .string()
      .optional()
      .describe('Environment variable name containing the bearer token (snake_case)'),
    lifecycle: RawLifecycleSchema.optional(),
    logging: RawLoggingSchema,
    allowedTools: ToolNamesSchema.optional().describe('Only these exact tool names are exposed (camelCase)'),
    allowed_tools: ToolNamesSchema.optional().describe('Only these exact tool names are exposed (snake_case)'),
    blockedTools: ToolNamesSchema.optional().describe('These exact tool names are hidden and blocked (camelCase)'),
    blocked_tools: ToolNamesSchema.optional().describe('These exact tool names are hidden and blocked (snake_case)'),
  })
  .superRefine((entry, ctx) => {
    const hasAllowed = entry.allowedTools !== undefined || entry.allowed_tools !== undefined;
    const hasBlocked = entry.blockedTools !== undefined || entry.blocked_tools !== undefined;
    if (hasAllowed && hasBlocked) {
      ctx.addIssue({
        code: 'custom',
        message: 'Specify either allowedTools or blockedTools, not both.',
        path: ['allowedTools'],
      });
    }
  })
  .describe('MCP server definition supporting both HTTP/SSE and stdio transports');

export const RawConfigSchema = z
  .object({
    mcpServers: z.record(z.string(), RawEntrySchema).describe('Map of server names to their configurations'),
    imports: z
      .array(ImportKindSchema)
      .optional()
      .describe('Editor configurations to import servers from. Omit to use defaults, or set to [] to disable imports'),
  })
  .describe('mcporter configuration file schema');

export type RawEntry = z.infer<typeof RawEntrySchema>;
export type RawConfig = z.infer<typeof RawConfigSchema>;

export interface HttpCommand {
  readonly kind: 'http';
  readonly url: URL;
  readonly headers?: Record<string, string>;
}

export interface StdioCommand {
  readonly kind: 'stdio';
  readonly command: string;
  readonly args: string[];
  readonly cwd: string;
}

export type CommandSpec = HttpCommand | StdioCommand;

export interface ServerSource {
  readonly kind: 'local' | 'import';
  readonly path: string;
  readonly importKind?: ImportKind;
}

export type ServerLifecycle =
  | {
      mode: 'keep-alive';
      idleTimeoutMs?: number;
    }
  | {
      mode: 'ephemeral';
    };

export interface ServerLoggingOptions {
  readonly daemon?: {
    readonly enabled?: boolean;
  };
}

export interface ServerDefinition {
  readonly name: string;
  readonly description?: string;
  readonly command: CommandSpec;
  readonly env?: Record<string, string>;
  readonly auth?: string;
  readonly tokenCacheDir?: string;
  readonly clientName?: string;
  readonly oauthRedirectUrl?: string;
  readonly oauthScope?: string;
  readonly oauthCommand?: {
    readonly args: string[];
  };
  readonly source?: ServerSource;
  readonly sources?: readonly ServerSource[];
  readonly lifecycle?: ServerLifecycle;
  readonly logging?: ServerLoggingOptions;
  /** When specified, only these exact tool names are exposed. Empty array blocks all tools. */
  readonly allowedTools?: readonly string[];
  /** When specified, these exact tool names are hidden and blocked. Cannot be combined with allowedTools. */
  readonly blockedTools?: readonly string[];
}

export interface LoadConfigOptions {
  readonly configPath?: string;
  readonly rootDir?: string;
}
