import { z } from 'zod';

export const ImportKindSchema = z.enum([
  'cursor',
  'claude-code',
  'claude-desktop',
  'codex',
  'windsurf',
  'opencode',
  'vscode',
]);

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

const RawLifecycleSchema = z.union([
  z.literal('keep-alive'),
  z.literal('ephemeral'),
  z.object({
    mode: z.union([z.literal('keep-alive'), z.literal('ephemeral')]),
    idleTimeoutMs: z.number().int().positive().optional(),
  }),
]);

export type RawLifecycle = z.infer<typeof RawLifecycleSchema>;

const RawLoggingSchema = z
  .object({
    daemon: z
      .object({
        enabled: z.boolean().optional(),
      })
      .optional(),
  })
  .optional();

export const RawEntrySchema = z.object({
  description: z.string().optional(),
  baseUrl: z.string().optional(),
  base_url: z.string().optional(),
  url: z.string().optional(),
  serverUrl: z.string().optional(),
  server_url: z.string().optional(),
  command: z.union([z.string(), z.array(z.string())]).optional(),
  executable: z.string().optional(),
  args: z.array(z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  auth: z.string().optional(),
  tokenCacheDir: z.string().optional(),
  token_cache_dir: z.string().optional(),
  clientName: z.string().optional(),
  client_name: z.string().optional(),
  oauthRedirectUrl: z.string().optional(),
  oauth_redirect_url: z.string().optional(),
  oauthScope: z.string().optional(),
  oauth_scope: z.string().optional(),
  oauthCommand: z
    .object({
      args: z.array(z.string()),
    })
    .optional(),
  oauth_command: z
    .object({
      args: z.array(z.string()),
    })
    .optional(),
  bearerToken: z.string().optional(),
  bearer_token: z.string().optional(),
  bearerTokenEnv: z.string().optional(),
  bearer_token_env: z.string().optional(),
  lifecycle: RawLifecycleSchema.optional(),
  logging: RawLoggingSchema,
});

export const RawConfigSchema = z.object({
  mcpServers: z.record(z.string(), RawEntrySchema),
  imports: z.array(ImportKindSchema).optional(),
});

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
}

export interface LoadConfigOptions {
  readonly configPath?: string;
  readonly rootDir?: string;
}
