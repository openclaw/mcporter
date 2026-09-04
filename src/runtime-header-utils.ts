import { resolveEnvPlaceholders } from './env.js';

// materializeHeaders resolves environment placeholders in server header definitions.
export function materializeHeaders(
  headers: Record<string, string> | undefined,
  serverName: string,
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }

  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    try {
      resolved[key] = resolveEnvPlaceholders(value, env);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to resolve header '${key}' for server '${serverName}': ${message}`, { cause: error });
    }
  }

  return resolved;
}
