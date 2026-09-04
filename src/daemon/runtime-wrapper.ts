import { MCPORTER_VERSION } from '../version.js';
import type { ServerDefinition } from '../config.js';
import { isKeepAliveServer } from '../lifecycle.js';
import type {
  CallOptions,
  ConnectOptions,
  ListResourcesOptions,
  ListToolsOptions,
  ReadResourceOptions,
  Runtime,
} from '../runtime.js';
import type { DaemonClient } from './client.js';

interface KeepAliveRuntimeOptions {
  readonly daemonClient: DaemonClient | null;
  readonly keepAliveServers: Set<string>;
}

export function createKeepAliveRuntime(base: Runtime, options: KeepAliveRuntimeOptions): Runtime {
  if (!options.daemonClient || options.keepAliveServers.size === 0) {
    return base;
  }
  return new KeepAliveRuntime(base, options.daemonClient, options.keepAliveServers);
}

class KeepAliveRuntime implements Runtime {
  constructor(
    private readonly base: Runtime,
    private readonly daemon: DaemonClient,
    private readonly keepAliveServers: Set<string>
  ) {
    const info = base.getClientInfo?.();
    if (info) this.daemon.setDefinitions(base.getDefinitions(), info);
    else this.daemon.setDefinitions(base.getDefinitions());
  }

  getClientInfo(): { name: string; version: string } {
    return this.base.getClientInfo?.() ?? { name: 'mcporter', version: MCPORTER_VERSION };
  }

  listServers(): string[] {
    return this.base.listServers();
  }

  getDefinitions(): ServerDefinition[] {
    return this.base.getDefinitions();
  }

  getDefinition(server: string): ServerDefinition {
    return this.base.getDefinition(server);
  }

  registerDefinition(definition: ServerDefinition, options?: { overwrite?: boolean }): void {
    this.base.registerDefinition(definition, options);
    this.daemon.setDefinitions(this.base.getDefinitions(), this.base.getClientInfo?.());
    if (isKeepAliveServer(definition)) {
      this.keepAliveServers.add(definition.name);
    } else {
      this.keepAliveServers.delete(definition.name);
    }
  }

  async getInstructions(server: string): Promise<string | undefined> {
    return this.base.getInstructions?.(server);
  }

  async listTools(server: string, options?: ListToolsOptions): Promise<Awaited<ReturnType<Runtime['listTools']>>> {
    if (options?.oauthSessionOptions) {
      return this.base.listTools(server, options);
    }
    if (this.shouldUseDaemon(server)) {
      return (await this.invokeOnce(server, 'listTools', () =>
        this.daemon.listTools({
          server,
          includeSchema: options?.includeSchema,
          autoAuthorize: options?.autoAuthorize,
          allowCachedAuth: options?.allowCachedAuth ?? true,
          disableOAuth: options?.disableOAuth,
          timeoutMs: options?.timeoutMs,
        })
      )) as Awaited<ReturnType<Runtime['listTools']>>;
    }
    return this.base.listTools(server, options);
  }

  async callTool(server: string, toolName: string, options?: CallOptions): Promise<unknown> {
    if (this.shouldUseDaemon(server)) {
      return this.invokeOnce(server, 'callTool', () =>
        this.daemon.callTool({
          server,
          tool: toolName,
          args: options?.args,
          timeoutMs: options?.timeoutMs,
          disableOAuth: options?.disableOAuth,
        })
      );
    }
    return this.base.callTool(server, toolName, options);
  }

  async listResources(server: string, options?: ListResourcesOptions): Promise<unknown> {
    if (options?.oauthSessionOptions) {
      return this.base.listResources(server, options);
    }
    const { allowCachedAuth, disableOAuth, ...params } = options ?? {};
    if (this.shouldUseDaemon(server)) {
      return this.invokeOnce(server, 'listResources', () =>
        this.daemon.listResources({ server, params, allowCachedAuth, disableOAuth })
      );
    }
    return this.base.listResources(server, options);
  }

  async readResource(server: string, uri: string, options?: ReadResourceOptions): Promise<unknown> {
    if (options?.oauthSessionOptions) {
      return this.base.readResource(server, uri, options);
    }
    if (this.shouldUseDaemon(server)) {
      return this.invokeOnce(server, 'readResource', () =>
        this.daemon.readResource({
          server,
          uri,
          allowCachedAuth: options?.allowCachedAuth,
          disableOAuth: options?.disableOAuth,
        })
      );
    }
    return this.base.readResource(server, uri, options);
  }

  async connect(server: string, options?: ConnectOptions): Promise<Awaited<ReturnType<Runtime['connect']>>> {
    return this.base.connect(server, options);
  }

  async close(server?: string): Promise<void> {
    if (!server) {
      await this.daemon.release();
      await this.base.close();
      return;
    }
    if (this.shouldUseDaemon(server)) {
      await this.daemon.closeServer({ server }).catch(() => {});
      return;
    }
    await this.base.close(server);
  }

  private shouldUseDaemon(server: string): boolean {
    return this.keepAliveServers.has(server);
  }

  private async invokeOnce<T>(_server: string, _operation: string, action: () => Promise<T>): Promise<T> {
    return action();
  }
}
