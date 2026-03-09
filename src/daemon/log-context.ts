import fsSync from 'node:fs';
import path from 'node:path';

export interface LogContext {
  enabled: boolean;
  logAllServers: boolean;
  servers: Set<string>;
  writer?: fsSync.WriteStream;
}

export function createLogContext(options: {
  enabled: boolean;
  logAllServers: boolean;
  servers: Set<string>;
  logPath?: string;
}): LogContext {
  const derivedEnabled = options.enabled || options.logAllServers || options.servers.size > 0;
  const context: LogContext = {
    enabled: derivedEnabled,
    logAllServers: options.logAllServers,
    servers: options.servers,
  };
  if (derivedEnabled && options.logPath) {
    try {
      fsSync.mkdirSync(path.dirname(options.logPath), { recursive: true });
      context.writer = fsSync.createWriteStream(options.logPath, {
        flags: 'a',
      });
    } catch (error) {
      console.warn(`[daemon] Failed to open log file ${options.logPath}: ${(error as Error).message}`);
    }
  }
  return context;
}

export function logEvent(context: LogContext, message: string): void {
  if (!context.enabled) {
    return;
  }
  const line = `[daemon] ${new Date().toISOString()} ${message}`;
  console.log(line);
  try {
    context.writer?.write(`${line}\n`);
  } catch {
    // ignore file write failures
  }
}

export async function disposeLogContext(context: LogContext): Promise<void> {
  const writer = context.writer;
  if (!writer) {
    return;
  }
  await new Promise<void>((resolve) => {
    writer.end(() => resolve());
    writer.on('error', () => resolve());
  });
}

export function shouldLogServer(context: LogContext, server: string): boolean {
  if (!context.enabled) {
    return false;
  }
  if (context.logAllServers) {
    return true;
  }
  return context.servers.has(server);
}

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'unknown';
}
