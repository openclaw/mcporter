import { privateFixtureDirectory } from './helpers/private-directory.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { expect, it, vi } from 'vitest';
import { createRelayFixture } from './helpers/chrome-relay.js';
import { DaemonClient, resolveDaemonPaths } from '../src/daemon/client.js';
import { runDaemonHost, type DaemonHostHandle } from '../src/daemon/host.js';
import { fixtureResult } from './helpers/singleton.js';
import { generateCli } from '../src/generate-cli.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { budget } from './helpers/timing.js';

// These end-to-end cases launch processes and bundle a CLI; Windows needs the shared spawn budget.
vi.setConfig({ testTimeout: budget(10_000) });

for (const conflictFirst of [true, false])
  it(`retains one real fixture child over authenticated relay after conflicts (conflict first=${conflictFirst})`, async () => {
    const relay = await createRelayFixture();
    const root = await privateFixtureDirectory('mcp-chrome-');
    const previous = process.env.MCPORTER_DAEMON_DIR;
    process.env.MCPORTER_DAEMON_DIR = path.join(root, '.mcporter');
    const info = os.userInfo();
    const identity = vi.spyOn(os, 'userInfo').mockReturnValue({ ...info, homedir: root });
    const require = createRequire(import.meta.url);
    const command = path.join(root, 'chrome-devtools-mcp');
    let host: DaemonHostHandle | undefined;
    let queuedProof: Promise<unknown> | undefined;
    let setupClock: { mockRestore(): void } | undefined;
    try {
      await fs.writeFile(
        command,
        `#!${process.execPath}
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import {McpServer} from '${pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/mcp.js')).href}';
import {StdioServerTransport} from '${pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/stdio.js')).href}';
const endpoint=process.argv[process.argv.indexOf('--wsEndpoint')+1];
const headers=JSON.parse(process.argv[process.argv.indexOf('--wsHeaders')+1]);
const url=new URL(endpoint);const ws=net.createConnection(Number(url.port),url.hostname);await new Promise((resolve,reject)=>{ws.once('connect',()=>ws.write('GET '+url.pathname+' HTTP/1.1\\r\\nHost: '+url.host+'\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\nSec-WebSocket-Version: 13\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\nAuthorization: '+headers.Authorization+'\\r\\n\\r\\n'));ws.once('data',chunk=>chunk.toString().includes('101')?resolve():reject(new Error('synthetic websocket failed')));ws.once('error',reject);});
const id=randomUUID();fs.appendFileSync(${JSON.stringify(path.join(root, 'launches'))},id+'\\n');
const server=new McpServer({name:'synthetic-chrome',version:'1'});
server.registerTool('identity',{inputSchema:{}},async()=>{fs.appendFileSync(${JSON.stringify(path.join(root, 'effects'))},'effect\\n');return {content:[{type:'text',text:JSON.stringify({id,relay:true})}]};});
server.registerTool('held',{inputSchema:{}},async()=>{fs.writeFileSync(${JSON.stringify(path.join(root, 'held'))},'entered');while(!fs.existsSync(${JSON.stringify(path.join(root, 'resume'))}))await new Promise(r=>setTimeout(r,5));return {content:[{type:'text',text:JSON.stringify({id,relay:true})}]};});
await server.connect(new StdioServerTransport());
`,
        { mode: 0o700 }
      );
      const env = {
        ...relay.definition.env,
        HOME: root,
        USERPROFILE: root,
        MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY: 'require',
      };
      const definition = {
        ...relay.definition,
        name: 'canonical',
        command: { kind: 'stdio' as const, command: path.basename(command), args: ['--autoConnect'], cwd: root },
        env,
        protocolVersion: 'legacy' as const,
        lifecycle: { mode: 'keep-alive' as const, idleTimeoutMs: 10 },
        chromeDevtoolsRelay: 'require' as const,
      };
      await fs.mkdir(path.join(root, '.mcporter'), { recursive: true });
      await fs.writeFile(
        path.join(root, '.mcporter', 'mcporter.json'),
        JSON.stringify({
          imports: [],
          daemonIdleTimeoutMs: 500,
          mcpServers: {
            'chrome-isolated': { command, args: [], cwd: root },
            canonical: {
              command: path.basename(command),
              args: ['--autoConnect'],
              cwd: root,
              env,
              protocolVersion: 'legacy',
              lifecycle: { mode: 'keep-alive', idleTimeoutMs: 10 },
              chromeDevtoolsRelay: 'require',
            },
          },
        })
      );
      // Both are shadowed by .mcporter/mcporter.json, just as in ordinary config selection.
      const shadow = JSON.stringify({
        imports: [],
        mcpServers: { shadow: { command, args: ['--autoConnect'], cwd: root, chromeDevtoolsRelay: 'off' } },
      });
      await fs.writeFile(path.join(root, '.mcporter', 'mcporter.jsonc'), shadow);
      await fs.mkdir(path.join(root, '.config', 'mcporter'), { recursive: true });
      await fs.writeFile(path.join(root, '.config', 'mcporter', 'mcporter.json'), shadow);
      const originalPath = process.env.PATH;
      process.env.PATH = `${root}${path.delimiter}${originalPath ?? ''}`;
      // Empty-host expiry is tested separately; hold its clock until the fixture owns Chrome.
      setupClock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
      try {
        host = await runDaemonHost({ ...resolveDaemonPaths(''), configPath: '' });
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }
      const client = (name: string, off = false) => {
        const c = new DaemonClient({ configPath: '' });
        c.setDefinitions([
          {
            ...definition,
            name,
            ...(off
              ? { chromeDevtoolsRelay: 'off' as const, env: { ...env, MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY: 'off' } }
              : {}),
          },
        ]);
        return c;
      };
      const reject = async () => {
        await expect(client('conflict', true).callTool({ server: 'conflict', tool: 'identity' })).rejects.toMatchObject(
          { code: 'browser_owner_conflict' }
        );
        for (const incompatible of [
          { ...definition, env: { ...env, EXPLICIT_CONNECTION_INPUT: 'different' } },
          { ...definition, env: { ...env, PATH: '/explicit-different-path' } },
          { ...definition, env: { ...env, MCPORTER_CHROME_DEVTOOLS_RELAY_URL: 'http://127.0.0.1:1' } },
          { ...definition, command: { ...definition.command, args: ['--browserUrl', 'http://127.0.0.1:9222'] } },
          { ...definition, command: { ...definition.command, args: [] } },
        ]) {
          const c = new DaemonClient({ configPath: '' });
          c.setDefinitions([incompatible]);
          await expect(c.callTool({ server: 'canonical', tool: 'identity' })).rejects.toMatchObject({
            code: 'browser_owner_conflict',
          });
          await c.release();
        }
      };
      if (conflictFirst) {
        await reject();
        expect(relay.activeConnections).toBe(0);
        await expect(fs.stat(path.join(root, 'launches'))).rejects.toMatchObject({ code: 'ENOENT' });
      }
      const a = client('a'),
        b = client('b');
      const settled = await Promise.allSettled([
        a.callTool({ server: 'a', tool: 'identity' }),
        b.callTool({ server: 'b', tool: 'identity' }),
      ]);
      const results = settled.map((result) => {
        if (result.status === 'rejected') throw result.reason;
        return result.value;
      });
      const first = fixtureResult(results[0]);
      setupClock.mockRestore();
      setupClock = undefined;
      await new Promise((resolve) => setTimeout(resolve, 550));
      expect(fixtureResult(results[1]).id).toBe(first.id);
      expect(JSON.stringify(results[0])).toContain('relay');
      await reject();
      expect(fixtureResult(await a.callTool({ server: 'a', tool: 'identity' })).id).toBe(first.id);
      expect((await fs.readFile(path.join(root, 'launches'), 'utf8')).trim().split('\n')).toEqual([first.id]);
      expect(host.status().servers).toHaveLength(1);
      expect(relay.activeConnections).toBe(1);
      const bundlePath = path.join(root, 'generated.cjs');
      await generateCli({
        serverRef: 'canonical',
        configPath: path.join(root, '.mcporter', 'mcporter.json'),
        outputPath: path.join(root, 'generated.ts'),
        bundle: bundlePath,
        runtime: 'node',
      });
      const generated = await promisify(execFile)(process.execPath, [bundlePath, 'identity', '--output', 'json'], {
        cwd: root,
        env: {
          ...process.env,
          PATH: '',
          HOME: root,
          USERPROFILE: root,
          PWD: root,
          GUI_SHELL_CONTEXT: 'another-client',
        },
      });
      expect(JSON.parse(generated.stdout).id).toBe(first.id);
      expect(host.status().servers[0]?.idleBlocked).toBe('browser-owner');
      expect(host.status().idleShutdownBlocked).toBe(true);
      expect((await fs.readFile(path.join(root, 'launches'), 'utf8')).trim().split('\n')).toEqual([first.id]);
      const ownerBefore = host.status().browserOwner;
      const firstCall = a.callTool({ server: 'a', tool: 'held' });
      queuedProof = Promise.allSettled([firstCall]);
      await vi.waitFor(async () => expect(await fs.readFile(path.join(root, 'held'), 'utf8')).toBe('entered'));
      const effectsBefore = await fs.readFile(path.join(root, 'effects'), 'utf8');
      const queuedCall = expect(b.callTool({ server: 'b', tool: 'identity' })).rejects.toMatchObject({
        code: 'browser_owner_conflict',
      });
      queuedProof = Promise.allSettled([firstCall, queuedCall]);
      await vi.waitFor(() => expect(host!.status().servers[0]?.activeCalls).toBe(2));
      const credential = path.join(relay.directory, 'browser-extension-relay.secret');
      if (conflictFirst) await fs.writeFile(credential, 'b'.repeat(64));
      else await fs.unlink(credential);
      await fs.writeFile(path.join(root, 'resume'), 'continue');
      expect(fixtureResult(await firstCall).id).toBe(first.id);
      await queuedCall;
      expect(await fs.readFile(path.join(root, 'effects'), 'utf8')).toBe(effectsBefore);
      expect(host.status().browserOwner).toEqual(ownerBefore);
      await expect(client('rotated').getServerMetadata({ server: 'rotated' })).rejects.toMatchObject({
        code: 'browser_owner_conflict',
      });
      expect((await fs.readFile(path.join(root, 'launches'), 'utf8')).trim().split('\n')).toEqual([first.id]);
      await fs.writeFile(path.join(relay.directory, 'browser-extension-relay.secret'), 'a'.repeat(64), { mode: 0o600 });
      expect(fixtureResult(await a.callTool({ server: 'a', tool: 'identity' })).id).toBe(first.id);
      expect((await fs.readFile(path.join(root, 'effects'), 'utf8')).split('effect').length).toBe(
        effectsBefore.split('effect').length + 1
      );
    } finally {
      await fs.writeFile(path.join(root, 'resume'), 'cleanup');
      await queuedProof;
      setupClock?.mockRestore();
      await host?.close();
      identity.mockRestore();
      if (previous === undefined) delete process.env.MCPORTER_DAEMON_DIR;
      else process.env.MCPORTER_DAEMON_DIR = previous;
      await relay.close();
      await fs.rm(relay.directory, { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  });
