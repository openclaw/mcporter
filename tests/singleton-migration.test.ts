import { randomBytes } from 'node:crypto';
import { privateFixtureDirectory } from './helpers/private-directory.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { assertLegacyDrained, legacyDaemons, stopVerifiedLegacyDaemons } from '../src/daemon/migration.js';
import { secureDaemonDirectory, daemonRunDir } from '../src/daemon/paths.js';

it('blocks coexistence and waits for a verified legacy host and its owned child to retire', async () => {
  const root = await privateFixtureDirectory('mcp-cutover-');
  const previous = process.env.MCPORTER_DAEMON_DIR;
  process.env.MCPORTER_DAEMON_DIR = root;
  await secureDaemonDirectory();
  const name = `daemon-${randomBytes(6).toString('hex')}`;
  const socket =
    process.platform === 'win32' ? `\\\\.\\pipe\\mcporter-${name}` : path.join(daemonRunDir(), `${name}.sock`);
  const metadata = path.join(daemonRunDir(), `${name}.json`);
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const net=require('node:net'),fs=require('node:fs'),{spawn}=require('node:child_process');
 const owned=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 const server=net.createServer(s=>s.on('data',chunk=>{const r=JSON.parse(chunk);s.end(JSON.stringify({id:r.id,ok:true,result:r.method==='status'?{pid:process.pid,socketPath:${JSON.stringify(socket)},protocolVersion:1,servers:[]}:true}));if(r.method==='stop'){server.close();setTimeout(()=>owned.kill(),250);}}));
 server.listen(${JSON.stringify(socket)},()=>fs.writeFileSync(${JSON.stringify(metadata)},JSON.stringify({pid:process.pid,socketPath:${JSON.stringify(socket)}}),{mode:384}));`,
    ],
    { stdio: 'ignore' }
  );
  try {
    for (let i = 0; i < 100; i++) {
      if (await fs.stat(metadata).catch(() => undefined)) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(await legacyDaemons()).toEqual([{ pid: child.pid, socketPath: socket, verified: true }]);
    await expect(assertLegacyDrained()).rejects.toMatchObject({ code: 'legacy_daemon_conflict' });
    const start = Date.now();
    await stopVerifiedLegacyDaemons();
    expect(Date.now() - start).toBeGreaterThanOrEqual(200);
    await expect(assertLegacyDrained()).resolves.toBeUndefined();
    await expect(fs.stat(path.join(daemonRunDir(), 'legacy-retirement.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise<void>((r) => child.once('exit', () => r()));
    }
    if (previous === undefined) delete process.env.MCPORTER_DAEMON_DIR;
    else process.env.MCPORTER_DAEMON_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});
it('refuses to stop metadata-only PID claims without an owned legacy protocol socket', async () => {
  const root = await privateFixtureDirectory('mcp-unverified-');
  const previous = process.env.MCPORTER_DAEMON_DIR;
  process.env.MCPORTER_DAEMON_DIR = root;
  try {
    await secureDaemonDirectory();
    await fs.writeFile(
      path.join(daemonRunDir(), 'daemon-abcdef.json'),
      JSON.stringify({ pid: process.pid, socketPath: path.join(daemonRunDir(), 'daemon-abcdef.sock') })
    );
    await expect(stopVerifiedLegacyDaemons()).rejects.toMatchObject({ code: 'legacy_daemon_unverified' });
  } finally {
    if (previous === undefined) delete process.env.MCPORTER_DAEMON_DIR;
    else process.env.MCPORTER_DAEMON_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});
