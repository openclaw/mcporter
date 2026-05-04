import type { EphemeralServerSpec } from './adhoc-server.js';

interface ExtractOptions {
  allowPersist?: boolean;
}

// extractEphemeralServerFlags scans argv for ad-hoc server descriptors (HTTP/STDIO/env/etc.)
// and removes them so higher-level parsers can focus on command-specific flags.
export function extractEphemeralServerFlags(
  args: string[],
  options: ExtractOptions = {}
): EphemeralServerSpec | undefined {
  let spec: EphemeralServerSpec | undefined;
  const ensureSpec = (): EphemeralServerSpec => {
    if (!spec) {
      spec = {};
    }
    return spec;
  };

  const allowPersist = options.allowPersist ?? true;
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (!token) {
      index += 1;
      continue;
    }

    if (token === '--http-url' || token === '--sse') {
      const value = args[index + 1];
      if (!value) {
        throw new Error("Flag '--http-url' requires a value.");
      }
      ensureSpec().httpUrl = value;
      args.splice(index, 2);
      continue;
    }

    if (token === '--allow-http' || token === '--insecure') {
      ensureSpec().allowInsecureHttp = true;
      args.splice(index, 1);
      continue;
    }

    if (token === '--stdio') {
      const value = args[index + 1];
      if (!value) {
        throw new Error("Flag '--stdio' requires a value.");
      }
      ensureSpec().stdioCommand = value;
      args.splice(index, 2);
      continue;
    }

    if (token === '--stdio-arg') {
      const value = args[index + 1];
      if (!value) {
        throw new Error("Flag '--stdio-arg' requires a value.");
      }
      const current = ensureSpec();
      current.stdioArgs = [...(current.stdioArgs ?? []), value];
      args.splice(index, 2);
      continue;
    }

    if (token === '--env') {
      const value = args[index + 1];
      const current = ensureSpec();
      const envMap = current.env ? { ...current.env } : {};
      parseKeyValue(value, envMap, '--env');
      current.env = envMap;
      args.splice(index, 2);
      continue;
    }

    if (token === '--header') {
      const value = args[index + 1];
      const current = ensureSpec();
      const headerMap = current.headers ? { ...current.headers } : {};
      parseKeyValue(value, headerMap, '--header');
      current.headers = headerMap;
      args.splice(index, 2);
      continue;
    }

    if (token === '--cwd') {
      const value = args[index + 1];
      if (!value) {
        throw new Error("Flag '--cwd' requires a value.");
      }
      ensureSpec().cwd = value;
      args.splice(index, 2);
      continue;
    }

    if (token === '--name') {
      const value = args[index + 1];
      if (!value) {
        throw new Error("Flag '--name' requires a value.");
      }
      ensureSpec().name = value;
      args.splice(index, 2);
      continue;
    }

    if (token === '--description') {
      const value = args[index + 1];
      if (!value) {
        throw new Error("Flag '--description' requires a value.");
      }
      ensureSpec().description = value;
      args.splice(index, 2);
      continue;
    }

    if (allowPersist && token === '--persist') {
      const value = args[index + 1];
      if (!value) {
        throw new Error("Flag '--persist' requires a value.");
      }
      ensureSpec().persistPath = value;
      args.splice(index, 2);
      continue;
    }

    index += 1;
  }

  return spec;
}

function parseKeyValue(value: string | undefined, target: Record<string, string>, flagName: string): void {
  if (!value?.includes('=')) {
    throw new Error(`Flag '${flagName}' requires KEY=value.`);
  }
  const [key, ...rest] = value.split('=');
  if (!key) {
    throw new Error(`Flag '${flagName}' requires KEY=value.`);
  }
  target[key] = rest.join('=');
}
