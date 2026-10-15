import type { EphemeralServerSpec } from './adhoc-server.js';

const VALUE_FLAGS = new Set([
  '--http-url',
  '--sse',
  '--stdio',
  '--stdio-arg',
  '--env',
  '--header',
  '--cwd',
  '--name',
  '--description',
  '--persist',
]);

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
    const rawToken = args[index];
    if (rawToken === '--') {
      break;
    }
    if (!rawToken) {
      index += 1;
      continue;
    }

    const separator = rawToken.indexOf('=');
    const inline = separator > 0 && VALUE_FLAGS.has(rawToken.slice(0, separator));
    const token = inline ? rawToken.slice(0, separator) : rawToken;
    const width = inline ? 1 : 2;
    const readValue = (): string | undefined => (inline ? rawToken.slice(separator + 1) : args[index + 1]);

    if (token === '--http-url' || token === '--sse') {
      const value = readValue();
      if (!value) {
        throw new Error(`Flag '${token}' requires a value.`);
      }
      ensureSpec().httpUrl = value;
      args.splice(index, width);
      continue;
    }

    if (token === '--allow-http' || token === '--insecure') {
      ensureSpec().allowInsecureHttp = true;
      args.splice(index, 1);
      continue;
    }

    if (token === '--stdio') {
      const value = readValue();
      if (!value) {
        throw new Error("Flag '--stdio' requires a value.");
      }
      ensureSpec().stdioCommand = value;
      args.splice(index, width);
      continue;
    }

    if (token === '--stdio-arg') {
      const value = readValue();
      if (!value) {
        throw new Error("Flag '--stdio-arg' requires a value.");
      }
      const current = ensureSpec();
      current.stdioArgs = [...(current.stdioArgs ?? []), value];
      args.splice(index, width);
      continue;
    }

    if (token === '--env') {
      const value = readValue();
      const current = ensureSpec();
      const envMap = current.env ? { ...current.env } : {};
      parseKeyValue(value, envMap, '--env');
      current.env = envMap;
      args.splice(index, width);
      continue;
    }

    if (token === '--header') {
      const value = readValue();
      const current = ensureSpec();
      const headerMap = current.headers ? { ...current.headers } : {};
      parseKeyValue(value, headerMap, '--header');
      current.headers = headerMap;
      args.splice(index, width);
      continue;
    }

    if (token === '--cwd') {
      const value = readValue();
      if (!value) {
        throw new Error("Flag '--cwd' requires a value.");
      }
      ensureSpec().cwd = value;
      args.splice(index, width);
      continue;
    }

    if (token === '--name') {
      const value = readValue();
      if (!value) {
        throw new Error("Flag '--name' requires a value.");
      }
      ensureSpec().name = value;
      args.splice(index, width);
      continue;
    }

    if (token === '--description') {
      const value = readValue();
      if (!value) {
        throw new Error("Flag '--description' requires a value.");
      }
      ensureSpec().description = value;
      args.splice(index, width);
      continue;
    }

    if (allowPersist && token === '--persist') {
      const value = readValue();
      if (!value) {
        throw new Error("Flag '--persist' requires a value.");
      }
      ensureSpec().persistPath = value;
      args.splice(index, width);
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
