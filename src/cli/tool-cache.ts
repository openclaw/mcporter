import type { ListToolsOptions, Runtime } from '../runtime.js';
import { buildToolMetadataList, type ToolMetadata } from './generate/tools.js';

interface LoadToolMetadataOptions {
  includeSchema?: boolean;
  autoAuthorize?: boolean;
  allowCachedAuth?: boolean;
  disableOAuth?: boolean;
}

const runtimeCache = new WeakMap<Runtime, Map<string, Promise<ToolMetadata[]>>>();

function cacheKey(serverName: string, options: LoadToolMetadataOptions): string {
  const includeSchema = options.includeSchema !== false;
  const autoAuthorize = options.autoAuthorize !== false;
  const allowCachedAuth = options.allowCachedAuth !== false;
  const disableOAuth = options.disableOAuth === true;
  return `${serverName}::schema:${includeSchema ? '1' : '0'}::auth:${autoAuthorize ? '1' : '0'}::cached-auth:${allowCachedAuth ? '1' : '0'}::disable-oauth:${disableOAuth ? '1' : '0'}`;
}

export async function loadToolMetadata(
  runtime: Runtime,
  serverName: string,
  options: LoadToolMetadataOptions = {}
): Promise<ToolMetadata[]> {
  const key = cacheKey(serverName, options);
  let cache = runtimeCache.get(runtime);
  if (!cache) {
    cache = new Map();
    runtimeCache.set(runtime, cache);
  }
  const existing = cache.get(key);
  if (existing) {
    return existing;
  }
  const includeSchema = options.includeSchema !== false;
  const autoAuthorize = options.autoAuthorize !== false;
  const listOptions: ListToolsOptions = {
    includeSchema,
    autoAuthorize,
    allowCachedAuth: options.allowCachedAuth ?? true,
    disableOAuth: options.disableOAuth,
  };
  const promise = runtime
    .listTools(serverName, listOptions)
    // Listing and calling must survive a server whose tool names collide; only
    // codegen needs to reject the ambiguity outright.
    .then((tools) => buildToolMetadataList(tools, { sort: false, onCollision: 'skip' }))
    .catch((error) => {
      cache?.delete(key);
      throw error;
    });
  cache.set(key, promise);
  return promise;
}
