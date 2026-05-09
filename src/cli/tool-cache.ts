import type { ListToolsOptions, Runtime } from '../runtime.js';
import { buildToolMetadata, type ToolMetadata } from './generate/tools.js';

interface LoadToolMetadataOptions {
  includeSchema?: boolean;
  autoAuthorize?: boolean;
  allowCachedAuth?: boolean;
}

const runtimeCache = new WeakMap<Runtime, Map<string, Promise<ToolMetadata[]>>>();

function cacheKey(serverName: string, options: LoadToolMetadataOptions): string {
  const includeSchema = options.includeSchema !== false;
  const autoAuthorize = options.autoAuthorize !== false;
  const allowCachedAuth = options.allowCachedAuth === true;
  return `${serverName}::schema:${includeSchema ? '1' : '0'}::auth:${autoAuthorize ? '1' : '0'}::cached-auth:${allowCachedAuth ? '1' : '0'}`;
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
  const listOptions: ListToolsOptions =
    options.allowCachedAuth === undefined
      ? { includeSchema, autoAuthorize }
      : { includeSchema, autoAuthorize, allowCachedAuth: options.allowCachedAuth };
  const promise = runtime
    .listTools(serverName, listOptions)
    .then((tools) => tools.map((tool) => buildToolMetadata(tool)))
    .catch((error) => {
      cache?.delete(key);
      throw error;
    });
  cache.set(key, promise);
  return promise;
}
