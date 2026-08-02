import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  CallResult,
  ClientContext,
  ConnectionInfo,
  ConnectionIssueKind,
  DaemonCliOptions,
  HttpCommand,
  ImportKind,
  InteractiveElicitationOptions,
  LoadConfigOptions,
  NonInteractiveElicitationOptions,
  OAuthAuthorizationRequest,
  OAuthAuthorizationResponse,
  OAuthSession,
  OAuthSessionOptions,
  ProtocolVersion,
  RefreshableBearerOptions,
  ServerLifecycle,
  ServerLoggingOptions,
  ServerProxy,
  ServerSource,
  StdioCommand,
  ToolCallOptions,
} from '../src/index.js';
import { createServerProxy } from '../src/index.js';
import type { Runtime, ServerToolInfo } from '../src/runtime.js';

type CallLogEntry = {
  server: string;
  tool: string;
  options: unknown;
};

type PublicApiTypes = {
  clientContext: ClientContext;
  connectionInfo: ConnectionInfo;
  connectionIssueKind: ConnectionIssueKind;
  daemonCliOptions: DaemonCliOptions;
  httpCommand: HttpCommand;
  importKind: ImportKind;
  interactiveElicitationOptions: InteractiveElicitationOptions;
  loadConfigOptions: LoadConfigOptions;
  nonInteractiveElicitationOptions: NonInteractiveElicitationOptions;
  oauthAuthorizationRequest: OAuthAuthorizationRequest;
  oauthAuthorizationResponse: OAuthAuthorizationResponse;
  oauthSession: OAuthSession;
  oauthSessionOptions: OAuthSessionOptions;
  protocolVersion: ProtocolVersion;
  refreshableBearerOptions: RefreshableBearerOptions;
  serverLifecycle: ServerLifecycle;
  serverLoggingOptions: ServerLoggingOptions;
  serverProxy: ServerProxy;
  serverSource: ServerSource;
  stdioCommand: StdioCommand;
  toolCallOptions: ToolCallOptions;
};

function createComposableRuntime() {
  const listCalls: Array<{ server: string; options?: unknown }> = [];
  const callLog: CallLogEntry[] = [];

  const schemas: Record<string, ServerToolInfo[]> = {
    docs: [
      {
        name: 'lookup',
        description: 'Lookup documentation entries',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    ],
    summarize: [
      {
        name: 'summarize',
        description: 'Summarize content',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            style: { type: 'string', default: 'concise' },
          },
          required: ['text'],
        },
      },
    ],
  };

  const runtime: Pick<Runtime, 'listTools' | 'callTool' | 'getDefinition'> & {
    listCalls: typeof listCalls;
    callLog: typeof callLog;
  } = {
    listCalls,
    callLog,
    async listTools(server, options) {
      listCalls.push({ server, options });
      return schemas[server] ?? [];
    },
    async callTool(server, toolName, options) {
      callLog.push({ server, tool: toolName, options });

      if (server === 'docs' && toolName === 'lookup') {
        const query =
          typeof options?.args === 'object' && options?.args !== null
            ? (options.args as { query?: string }).query
            : undefined;
        return {
          content: [
            {
              type: 'text',
              text: `Reference entry for ${query ?? 'unknown topic'}`,
            },
          ],
        };
      }

      if (server === 'summarize' && toolName === 'summarize') {
        const args = (options?.args ?? {}) as { text?: string; style?: string };
        return {
          structuredContent: {
            summary: `Summary: ${(args.text ?? '').slice(0, 24)}`,
            style: args.style ?? 'concise',
          },
        };
      }

      throw new Error(`Unexpected call: ${server}.${toolName}`);
    },
    getDefinition(server) {
      return {
        name: server,
        description: '',
        command: {
          kind: 'stdio' as const,
          command: 'noop',
          args: [],
          cwd: process.cwd(),
        },
      };
    },
  };

  return runtime;
}

describe('index exports integration', () => {
  it('exports connection metadata returned by the runtime API', () => {
    const info = { protocolVersion: '2026-07-28', era: 'modern' } satisfies ConnectionInfo;

    expect(info.protocolVersion).toBe('2026-07-28');
    expectTypeOf<PublicApiTypes>().toBeObject();
  });

  it('composes proxies across MCP servers using the TypeScript API', async () => {
    const runtime = createComposableRuntime();
    const docs = createServerProxy(runtime as unknown as Runtime, 'docs') as Record<string, unknown>;
    const summarize = createServerProxy(runtime as unknown as Runtime, 'summarize') as Record<string, unknown>;

    const lookup = docs.lookup as (query: string) => Promise<CallResult>;
    const summarizeTool = summarize.summarize as (text: string) => Promise<CallResult>;

    const lookupResult = await lookup('TypeScript decorators');
    expect(lookupResult.text()).toBe('Reference entry for TypeScript decorators');

    const summaryResult = await summarizeTool(lookupResult.text() ?? '');
    const structured = summaryResult.structuredContent() as { summary?: string; style?: string };
    expect(structured?.style).toBe('concise');
    expect(structured?.summary).toMatch(/^Summary: Reference entry/);

    expect(runtime.listCalls).toEqual([
      { server: 'docs', options: { includeSchema: true } },
      { server: 'summarize', options: { includeSchema: true } },
    ]);

    expect(runtime.callLog).toEqual([
      {
        server: 'docs',
        tool: 'lookup',
        options: { args: { query: 'TypeScript decorators' } },
      },
      {
        server: 'summarize',
        tool: 'summarize',
        options: { args: { text: 'Reference entry for TypeScript decorators', style: 'concise' } },
      },
    ]);
  });
});
