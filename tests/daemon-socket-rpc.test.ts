import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { SocketFrames } from '../src/daemon/socket-rpc.js';

describe('daemon socket EOF', () => {
  it('classifies EOF during a pending request as a transport disconnect', async () => {
    const socket = new net.Socket();
    const frames = new SocketFrames(socket);
    const pending = frames.read();
    socket.emit('end');
    await expect(pending).rejects.toMatchObject({ code: 'ECONNRESET', message: 'Daemon connection ended.' });
    await expect(frames.read()).rejects.toMatchObject({ code: 'ECONNRESET' });
    expect(socket.destroyed).toBe(true);
  });

  it('keeps a complete response received before EOF', async () => {
    const socket = new net.Socket();
    const frames = new SocketFrames(socket);
    socket.emit('data', '{"id":"stop","ok":true,"result":true}\n');
    socket.emit('end');
    await expect(frames.read()).resolves.toEqual({ id: 'stop', ok: true, result: true });
    await expect(frames.read()).rejects.toMatchObject({ code: 'ECONNRESET' });
  });

  it('preserves protocol errors instead of classifying them as disconnects', async () => {
    const socket = new net.Socket();
    const frames = new SocketFrames(socket);
    socket.emit('data', 'not-json\n');
    socket.emit('end');
    const error = await frames.read().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty('message', 'Malformed daemon frame.');
    expect(error).not.toHaveProperty('code');
  });
});
