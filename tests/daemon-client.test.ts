import fs from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DaemonClient, resolveDaemonPaths } from '../src/daemon/client.js';
import { makeShortTempDir } from './fixtures/test-helpers.js';

describe('daemon client', () => {
  it('uses XDG_STATE_HOME for daemon paths unless MCPORTER_DAEMON_DIR is set', async () => {
    const tmpDir = await makeShortTempDir('mcpd-xdg');
    const originalDaemonDir = process.env.MCPORTER_DAEMON_DIR;
    const originalXdgStateHome = process.env.XDG_STATE_HOME;
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(path.join(tmpDir, 'home'));
    try {
      delete process.env.MCPORTER_DAEMON_DIR;
      process.env.XDG_STATE_HOME = path.join(tmpDir, 'state');
      const xdgPaths = resolveDaemonPaths(path.join(tmpDir, 'config.json'));
      expect(xdgPaths.metadataPath).toContain(path.join(tmpDir, 'state', 'mcporter', 'daemon'));

      process.env.MCPORTER_DAEMON_DIR = path.join(tmpDir, 'override');
      const overridePaths = resolveDaemonPaths(path.join(tmpDir, 'config.json'));
      expect(overridePaths.metadataPath).toContain(path.join(tmpDir, 'override', 'daemon'));
    } finally {
      homedirSpy.mockRestore();
      if (originalDaemonDir === undefined) {
        delete process.env.MCPORTER_DAEMON_DIR;
      } else {
        process.env.MCPORTER_DAEMON_DIR = originalDaemonDir;
      }
      if (originalXdgStateHome === undefined) {
        delete process.env.XDG_STATE_HOME;
      } else {
        process.env.XDG_STATE_HOME = originalXdgStateHome;
      }
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('keeps stdio sockets open until the daemon responds', async () => {
    const tmpDir = await makeShortTempDir('mcpd');
    const originalDir = process.env.MCPORTER_DAEMON_DIR;
    process.env.MCPORTER_DAEMON_DIR = tmpDir;
    const configPath = path.join(tmpDir, 'config.json');
    const { socketPath } = resolveDaemonPaths(configPath);
    await fs.mkdir(path.dirname(socketPath), { recursive: true });
    try {
      await fs.unlink(socketPath).catch(() => {});
      let clientClosedBeforeResponse = false;
      const server = net.createServer((socket) => {
        let responded = false;
        socket.on('data', () => {
          setTimeout(() => {
            responded = true;
            socket.write(JSON.stringify({ id: 'status', ok: true, result: { pong: true } }), () => {
              socket.end();
            });
          }, 20);
        });
        socket.on('end', () => {
          if (!responded) {
            clientClosedBeforeResponse = true;
          }
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => {
          server.off('error', reject);
          resolve();
        });
      });
      try {
        const client = new DaemonClient({ configPath });
        const result = await (
          client as unknown as { sendRequest: (method: 'status', params: object) => Promise<unknown> }
        ).sendRequest('status', {});
        expect(result).toEqual({ pong: true });
        expect(clientClosedBeforeResponse).toBe(false);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await fs.unlink(socketPath).catch(() => {});
      }
    } finally {
      if (originalDir) {
        process.env.MCPORTER_DAEMON_DIR = originalDir;
      } else {
        delete process.env.MCPORTER_DAEMON_DIR;
      }
    }
  });

  it('skips status preflight when daemon metadata is fresh', async () => {
    const tmpDir = await makeShortTempDir('mcpd-fresh');
    const originalDir = process.env.MCPORTER_DAEMON_DIR;
    process.env.MCPORTER_DAEMON_DIR = tmpDir;
    const configPath = path.join(tmpDir, 'config.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({ mcpServers: { warm: { command: 'node', args: ['server.js'], lifecycle: 'keep-alive' } } })
    );
    const { socketPath, metadataPath } = resolveDaemonPaths(configPath);
    await fs.mkdir(path.dirname(socketPath), { recursive: true });
    await fs.mkdir(path.dirname(metadataPath), { recursive: true });
    const configStats = await fs.stat(configPath);
    await fs.writeFile(
      metadataPath,
      JSON.stringify({
        pid: process.pid,
        socketPath,
        configPath,
        configLayers: [{ path: configPath, mtimeMs: configStats.mtimeMs }],
        startedAt: Date.now(),
      })
    );
    const methods: string[] = [];
    const server = net.createServer((socket) => {
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        buffer += chunk;
        const request = JSON.parse(buffer) as { id: string; method: string };
        methods.push(request.method);
        socket.end(JSON.stringify({ id: request.id, ok: true, result: { tools: [] } }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    try {
      const client = new DaemonClient({ configPath, configExplicit: true });
      await client.listTools({ server: 'warm' });
      expect(methods).toEqual(['listTools']);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.unlink(socketPath).catch(() => {});
      if (originalDir) {
        process.env.MCPORTER_DAEMON_DIR = originalDir;
      } else {
        delete process.env.MCPORTER_DAEMON_DIR;
      }
    }
  });
});
