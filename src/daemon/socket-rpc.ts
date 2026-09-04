import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { withFileLock } from '../fs-json.js';
import { daemonRunDir, secureDaemonDirectory } from './paths.js';
import { MAX_DAEMON_PAYLOAD_BYTES, type DaemonRequest, type DaemonResponse } from './protocol.js';

export async function daemonKey(): Promise<Buffer> {
  await secureDaemonDirectory();
  const file = path.join(daemonRunDir(), 'user.key');
  return withFileLock(file, async () => {
    try {
      await fs.writeFile(file, randomBytes(32), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const info = await fs.lstat(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (process.platform !== 'win32' && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))
    )
      throw new Error('Unsafe daemon authentication key ownership.');
    const key = await fs.readFile(file);
    if (key.length !== 32) throw new Error('Invalid daemon authentication key.');
    return key;
  });
}

export class SocketFrames {
  private buffer = '';
  private queue: unknown[] = [];
  private pending?: { resolve(value: unknown): void; reject(error: Error): void };
  private failure?: Error;
  private bytes = 0;
  constructor(readonly socket: net.Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.bytes += Buffer.byteLength(chunk);
      if (this.bytes > MAX_DAEMON_PAYLOAD_BYTES * 2) {
        this.fail(new Error('Daemon frame limit exceeded.'));
        return;
      }
      this.buffer += chunk;
      let newline: number;
      while ((newline = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        this.bytes = Buffer.byteLength(this.buffer);
        try {
          const value: unknown = JSON.parse(line);
          if (this.pending) {
            const pending = this.pending;
            this.pending = undefined;
            pending.resolve(value);
          } else if (this.queue.length < 8) this.queue.push(value);
          else {
            this.fail(new Error('Too many daemon frames.'));
            return;
          }
        } catch {
          this.fail(new Error('Malformed daemon frame.'));
          return;
        }
      }
    });
    socket.on('error', (error) => this.fail(error));
    socket.on('end', () => this.fail(new Error('Daemon connection ended.')));
  }
  private fail(error: Error): void {
    this.failure ??= error;
    this.pending?.reject(error);
    this.pending = undefined;
    this.socket.destroy();
  }
  read(): Promise<unknown> {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }
  write(value: unknown): void {
    this.socket.write(`${JSON.stringify(value)}\n`);
  }
}

function proof(key: Buffer, role: string, client: string, server: string): string {
  return createHmac('sha256', key).update(`mcporter-v3\0${role}\0${client}\0${server}`).digest('hex');
}
function nonce(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
function checkProof(actual: unknown, expected: string): void {
  if (!nonce(actual) || !timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex')))
    throw new Error('Daemon authentication failed; no configuration sent.');
}
export async function authenticateServer(frames: SocketFrames, key: Buffer): Promise<void> {
  const hello = (await frames.read()) as { hello?: unknown };
  if (!hello || !nonce(hello.hello)) throw new Error('Invalid daemon hello.');
  const server = randomBytes(32).toString('hex');
  frames.write({ nonce: server, proof: proof(key, 'server', hello.hello, server) });
  const auth = (await frames.read()) as { proof?: unknown };
  checkProof(auth?.proof, proof(key, 'client', hello.hello, server));
  frames.write({ authenticated: true });
}
async function authenticateClient(frames: SocketFrames, key: Buffer): Promise<void> {
  const client = randomBytes(32).toString('hex');
  frames.write({ hello: client });
  const hello = (await frames.read()) as { nonce?: unknown; proof?: unknown };
  if (!hello || !nonce(hello.nonce)) throw new Error('Invalid daemon authentication response.');
  checkProof(hello.proof, proof(key, 'server', client, hello.nonce));
  frames.write({ proof: proof(key, 'client', client, hello.nonce) });
  const ack = (await frames.read()) as { authenticated?: boolean };
  if (!ack?.authenticated) throw new Error('Daemon authentication failed.');
}

export async function requestDaemon<T>(
  socketPath: string,
  request: DaemonRequest,
  idleTimeoutMs: number
): Promise<DaemonResponse<T>> {
  const key = await daemonKey();
  const socket = net.createConnection(socketPath);
  const frames = new SocketFrames(socket);
  socket.setTimeout(idleTimeoutMs, () =>
    socket.destroy(
      Object.assign(new Error('Daemon request timed out; outcome unknown, not replayed.'), { code: 'ETIMEDOUT' })
    )
  );
  try {
    await authenticateClient(frames, key);
    frames.write(request);
    for (;;) {
      const response = (await frames.read()) as DaemonResponse<T> & { type?: string };
      if (!response || response.id !== request.id) throw new Error('Mismatched daemon response.');
      if (response.type === 'progress') continue;
      if (typeof response.ok !== 'boolean') throw new Error('Invalid daemon response.');
      return response;
    }
  } finally {
    key.fill(0);
    socket.destroy();
  }
}
