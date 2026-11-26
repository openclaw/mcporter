import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { ownedProcessTree, processInventory, awaitRetirement } from '../src/daemon/process-retirement.js';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { privateFixtureDirectory } from './helpers/private-directory.js';
import { ensureDistBuilt } from './helpers/dist.js';
import { budget } from './helpers/timing.js';

const exec = promisify(execFile);
const cliEntry = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'recovers synthetic prior-boot state, preserves evidence, and serializes concurrent starts',
  async () => {
    await ensureDistBuilt(cliEntry);
    const root = await fs.realpath(await privateFixtureDirectory('mcp-recover-'));
    const config = path.join(root, 'config.json');
    await fs.writeFile(config, JSON.stringify({ imports: [], mcpServers: {} }));
    const cli = (args: string[]) =>
      exec(process.execPath, [cliEntry, '--config', config, ...args], {
        env: { ...process.env, MCPORTER_DAEMON_DIR: root, MCPORTER_OAUTH_NO_BROWSER: '1' },
        timeout: budget(60_000),
      });
    const metadataPath = path.join(root, 'daemon', 'user.json');
    try {
      await cli(['daemon', 'start']);
      const initial = JSON.parse((await cli(['daemon', 'status', '--json'])).stdout);
      const owner = await ownedProcessTree(initial.pid);
      expect((await ownedProcessTree(initial.pid))[0]).toEqual(owner[0]);
      process.kill(initial.pid, 'SIGKILL');
      await awaitRetirement(owner);
      expect((await fs.lstat(path.join(root, 'daemon', 'user.sock'))).isSocket()).toBe(true);
      // Synthetic prior-boot evidence, not a controlled reboot. This live PID also
      // verifies that recovery never signals a process that reused the recorded PID.
      const stale = { ...initial, pid: process.pid, bootIdentity: { platform: process.platform, id: randomUUID() } };
      await fs.writeFile(metadataPath, JSON.stringify(stale), { mode: 0o600 });
      const results = await Promise.all([cli(['daemon', 'recover']), cli(['daemon', 'recover'])]);
      expect(results.some(({ stdout }) => stdout.includes('Recovered prior-boot daemon state'))).toBe(true);
      const archives = (await fs.readdir(path.dirname(metadataPath))).filter((name) =>
        name.startsWith('user.json.recovered-')
      );
      expect(archives).toHaveLength(1);
      expect(JSON.parse(await fs.readFile(path.join(path.dirname(metadataPath), archives[0]!), 'utf8'))).toEqual(stale);
      await Promise.all([cli(['daemon', 'start']), cli(['daemon', 'start'])]);
      const current = JSON.parse((await cli(['daemon', 'status', '--json'])).stdout);
      expect(current.generation).not.toBe(initial.generation);
      expect(current.bootIdentity.platform).toBe(process.platform);
      expect(current.bootIdentity.id).not.toBe(stale.bootIdentity.id);
      await expect(cli(['daemon', 'recover'])).rejects.toThrow('responding daemon');
      expect(JSON.parse(await fs.readFile(metadataPath, 'utf8')).generation).toBe(current.generation);
    } finally {
      await cli(['daemon', 'stop']).catch(() => {});
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  budget(90_000)
);

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux').each([false, true])(
  'refuses same-boot crash recovery with surviving descendant=%s',
  async (survivingDescendant) => {
    await ensureDistBuilt(cliEntry);
    const root = await fs.realpath(await privateFixtureDirectory('mcp-crash-'));
    const config = path.join(root, 'config.json');
    const script = path.join(root, 'fixture.mjs');
    const require = createRequire(import.meta.url);
    const sdk = (name: string) => pathToFileURL(require.resolve(`@modelcontextprotocol/sdk/server/${name}.js`)).href;
    await fs.writeFile(
      script,
      `import { McpServer } from '${sdk('mcp')}';
import { StdioServerTransport } from '${sdk('stdio')}';
import { spawn } from 'node:child_process';
const child = ${survivingDescendant ? "spawn(process.execPath, ['-e','setInterval(()=>{},1000)'], {stdio:'ignore'})" : 'undefined'};
child?.unref();
const server = new McpServer({name:'fixture',version:'1'});
server.registerTool('ping',{inputSchema:{}},async()=>({content:[{type:'text',text:'pong'}]}));
await server.connect(new StdioServerTransport());`
    );
    await fs.writeFile(
      config,
      JSON.stringify({
        imports: [],
        mcpServers: {
          fixture: { command: process.execPath, args: [script], lifecycle: 'keep-alive' },
        },
      })
    );
    const env = {
      ...process.env,
      MCPORTER_DAEMON_DIR: root,
      MCPORTER_OAUTH_NO_BROWSER: '1',
      MCPORTER_NO_FORCE_EXIT: '1',
    };
    const cli = (args: string[]) =>
      exec(process.execPath, [cliEntry, '--config', config, ...args], { env, timeout: budget(60_000) });
    // Owning the foreground ChildProcess also lets the harness reap it after SIGKILL.
    const daemon = spawn(process.execPath, [cliEntry, '--config', config, 'daemon', 'start', '--foreground'], {
      env,
      stdio: 'ignore',
    });
    let identities: Awaited<ReturnType<typeof ownedProcessTree>> = [];
    try {
      let status: { pid: number } | null = null;
      for (let attempt = 0; attempt < 100 && !status; attempt++) {
        status = JSON.parse((await cli(['daemon', 'status', '--json'])).stdout);
        if (!status) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(status?.pid).toBe(daemon.pid);
      expect((await cli(['call', 'fixture.ping'])).stdout).toContain('pong');
      identities = await ownedProcessTree(daemon.pid!);
      expect(identities.length).toBe(survivingDescendant ? 3 : 2);
      expect((await ownedProcessTree(daemon.pid!))[0]).toEqual(identities[0]);
      const exited = once(daemon, 'exit');
      daemon.kill('SIGKILL');
      await exited;
      if (!survivingDescendant) await awaitRetirement(identities);
      else {
        const inventory = await processInventory(identities.map((identity) => identity.pid));
        expect(
          inventory.processes.some(
            (item) => item.pid === identities.at(-1)!.pid && item.born === identities.at(-1)!.born
          )
        ).toBe(true);
      }
      const metadataPath = path.join(root, 'daemon', 'user.json');
      const stale = await fs.readFile(metadataPath, 'utf8');
      await expect(cli(['call', 'fixture.ping'])).rejects.toThrow('Previous daemon exited unexpectedly');
      await expect(cli(['daemon', 'recover'])).rejects.toThrow('Same-boot daemon retirement is unverified');
      expect(await fs.readFile(metadataPath, 'utf8')).toBe(stale);
    } finally {
      if (daemon.exitCode === null && daemon.signalCode === null) {
        const exited = once(daemon, 'exit');
        await cli(['daemon', 'stop']).catch(() => {});
        await exited;
      }
      const inventory = identities.length
        ? await processInventory(identities.map((identity) => identity.pid))
        : undefined;
      for (const identity of identities) {
        const current = inventory?.processes.find((item) => item.pid === identity.pid);
        if (current?.born === identity.born && current.owner === identity.owner) process.kill(identity.pid, 'SIGKILL');
      }
      await awaitRetirement(identities);
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  budget(90_000)
);
