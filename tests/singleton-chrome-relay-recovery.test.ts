import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it, vi } from 'vitest';
import type { ServerDefinition } from '../src/config.js';
import { DaemonClient, resolveDaemonPaths } from '../src/daemon/client.js';
import { runDaemonHost, type DaemonHostHandle } from '../src/daemon/host.js';
import { isProcessRunning } from '../src/process-utils.js';
import { createRelayFixture } from './helpers/chrome-relay.js';
import { privateFixtureDirectory } from './helpers/private-directory.js';
import { fixtureResult } from './helpers/singleton.js';
import { budget } from './helpers/timing.js';

vi.setConfig({ testTimeout: budget(15_000) });

it('replaces an idle Chrome child once after its relay disappears while stdio stays alive', async () => {
  const f = await chromeRecoveryFixture();
  try {
    const first = fixtureResult(await f.call('one', 'identity'));
    const [firstProcess] = await f.launches();
    const generation = f.host.status().generation;
    await f.relay.disconnectCdp();
    await vi.waitFor(() => expect(f.host.status().servers[0]?.connected).toBe(false), { timeout: budget(5_000) });
    expect(await f.launches()).toHaveLength(1);

    const [a, b] = await Promise.all([f.call('one', 'identity'), f.call('two', 'identity')]);
    const replacement = fixtureResult(a);
    expect(replacement.id).not.toBe(first.id);
    expect(fixtureResult(b).id).toBe(replacement.id);
    expect(f.host.status().generation).toBe(generation);
    expect(f.host.status().servers[0]?.connectionGeneration).toBe(2);
    expect(await f.launches()).toHaveLength(2);
    expect(f.relay.activeConnections).toBe(1);
    await vi.waitFor(() => expect(isProcessRunning(firstProcess!.pid)).toBe(false), { timeout: budget(5_000) });
  } finally {
    await f.close();
  }
});

it('does not replay a write interrupted by relay loss before recovering the next explicit call', async () => {
  const f = await chromeRecoveryFixture();
  try {
    const first = fixtureResult(await f.call('one', 'identity'));
    const interrupted = outcome(f.call('one', 'held_write'));
    await f.waitForFile('held');
    const queued = f.call('two', 'identity');
    await vi.waitFor(() => expect(f.host.status().servers[0]?.activeCalls).toBe(2));
    await f.relay.disconnectCdp();
    expectFailure(await interrupted);
    expect(await f.lines('effects')).toEqual(['write']);
    const replacement = fixtureResult(await queued);
    expect(replacement.id).not.toBe(first.id);
    expect(fixtureResult(await f.call('one', 'identity')).id).toBe(replacement.id);
    expect(f.host.status().servers[0]?.connectionGeneration).toBe(2);
    expect(await f.launches()).toHaveLength(2);
    expect(await f.lines('effects')).toEqual(['write']);
  } finally {
    await f.close();
  }
});

it.each(['legacy', 'auto'] as const)(
  'fails %s setup without a tool effect when the relay is lost before MCP initialization',
  async (protocolVersion) => {
    const f = await chromeRecoveryFixture({ holdSetup: true, protocolVersion });
    try {
      const interrupted = outcome(f.call('one', 'identity'));
      await f.waitForFile('setup');
      const [firstProcess] = await f.launches();
      await f.relay.disconnectCdp();
      expectFailure(await interrupted);
      expect(await f.lines('requests')).toEqual([]);
      expect(await f.launches()).toHaveLength(1);
      await f.releaseSetup();

      const replacement = fixtureResult(await f.call('one', 'identity'));
      expect(replacement.id).not.toBe(firstProcess!.id);
      expect(await f.lines('requests')).toEqual(['identity']);
      expect(await f.launches()).toHaveLength(2);
      expect(f.relay.activeConnections).toBe(1);
    } finally {
      await f.close();
    }
  }
);

it('releases the Chrome child and proxy during intentional host cleanup without resurrecting them', async () => {
  const f = await chromeRecoveryFixture();
  try {
    await f.call('one', 'identity');
    const launched = await f.launches();
    await f.host.close();
    await vi.waitFor(
      () => {
        expect(f.relay.activeConnections).toBe(0);
        expect(launched.every(({ pid }) => !isProcessRunning(pid))).toBe(true);
      },
      { timeout: budget(5_000) }
    );
    await f.host.close();
    expect(f.host.status().servers).toEqual([]);
    expect(await f.launches()).toEqual(launched);
  } finally {
    await f.close();
  }
});

type Launch = { id: string; pid: number };
type Outcome = { ok: true; result: unknown } | { ok: false; error: unknown };

function outcome(operation: Promise<unknown>): Promise<Outcome> {
  return operation.then(
    (result) => ({ ok: true, result }),
    (error: unknown) => ({ ok: false, error })
  );
}

function expectFailure(result: Outcome): void {
  if (result.ok) expect(result.result).toMatchObject({ isError: true });
  else expect(result.error).toBeInstanceOf(Error);
}

async function chromeRecoveryFixture(options: { holdSetup?: boolean; protocolVersion?: 'legacy' | 'auto' } = {}) {
  const root = await privateFixtureDirectory('mcp-relay-recovery-');
  const relay = await createRelayFixture();
  const previous = process.env.MCPORTER_DAEMON_DIR;
  process.env.MCPORTER_DAEMON_DIR = path.join(root, '.mcporter');
  const info = os.userInfo();
  const identity = vi.spyOn(os, 'userInfo').mockReturnValue({ ...info, homedir: root });
  const clients = new Map<string, DaemonClient>();
  const inFlight = new Set<Promise<unknown>>();
  let host: DaemonHostHandle | undefined;
  let relayClosed = false;
  const lines = async (name: string): Promise<string[]> => {
    try {
      return (await fs.readFile(path.join(root, name), 'utf8')).trim().split('\n').filter(Boolean);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  };
  const launches = async (): Promise<Launch[]> => (await lines('launches')).map((line) => JSON.parse(line) as Launch);
  const releaseSetup = () => fs.rm(path.join(root, 'hold-setup'), { force: true });
  const close = async () => {
    try {
      await releaseSetup();
      if (!relayClosed) {
        relayClosed = true;
        await relay.close();
      }
      await Promise.allSettled(inFlight);
      await Promise.allSettled([...clients.values()].map((client) => client.release()));
      await host?.close();
    } finally {
      identity.mockRestore();
      if (previous === undefined) delete process.env.MCPORTER_DAEMON_DIR;
      else process.env.MCPORTER_DAEMON_DIR = previous;
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(relay.directory, { recursive: true, force: true });
    }
  };
  try {
    if (options.holdSetup) await fs.writeFile(path.join(root, 'hold-setup'), 'hold');
    const command = path.join(root, 'chrome-devtools-mcp');
    await fs.writeFile(command, chromeChild(root), { mode: 0o700 });
    const env = { ...relay.definition.env, HOME: root, USERPROFILE: root };
    const definition: ServerDefinition = {
      name: 'chrome-devtools',
      command: { kind: 'stdio', command, args: ['--autoConnect'], cwd: root },
      env,
      protocolVersion: options.protocolVersion ?? 'legacy',
      lifecycle: { mode: 'keep-alive' },
      chromeDevtoolsRelay: 'require',
    };
    await fs.mkdir(path.join(root, '.mcporter'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.mcporter', 'mcporter.json'),
      JSON.stringify({
        imports: [],
        mcpServers: {
          'chrome-devtools': {
            command,
            args: ['--autoConnect'],
            cwd: root,
            env,
            protocolVersion: options.protocolVersion ?? 'legacy',
            lifecycle: 'keep-alive',
            chromeDevtoolsRelay: 'require',
          },
        },
      })
    );
    host = await runDaemonHost({ ...resolveDaemonPaths(''), configPath: '' });
    return {
      host,
      relay,
      lines,
      launches,
      releaseSetup,
      close,
      async waitForFile(name: string) {
        await vi.waitFor(async () => expect(await lines(name)).not.toEqual([]), { timeout: budget(5_000) });
      },
      async call(alias: string, tool: string) {
        let client = clients.get(alias);
        if (!client) {
          client = new DaemonClient({ configPath: '' });
          client.setDefinitions([{ ...definition, name: alias }]);
          clients.set(alias, client);
        }
        const operation = client.callTool({ server: alias, tool, timeoutMs: budget(5_000) });
        inFlight.add(operation);
        try {
          return await operation;
        } finally {
          inFlight.delete(operation);
        }
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

function chromeChild(root: string): string {
  const require = createRequire(import.meta.url);
  return `#!${process.execPath}
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {McpServer} from '${pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/mcp.js')).href}';
import {StdioServerTransport} from '${pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/stdio.js')).href}';
const root=${JSON.stringify(root)};
const id=randomUUID();
fs.appendFileSync(path.join(root,'launches'),JSON.stringify({id,pid:process.pid})+'\\n');
const url=new URL(process.argv[process.argv.indexOf('--wsEndpoint')+1]);
const headers=JSON.parse(process.argv[process.argv.indexOf('--wsHeaders')+1]);
const ws=net.createConnection(Number(url.port),url.hostname);
let relayClosed=false;
const closed=new Promise(resolve=>ws.once('close',()=>{relayClosed=true;resolve();}));
ws.on('error',()=>{});
process.stdin.once('end',()=>process.exit(0));
await new Promise((resolve,reject)=>{
  let response='';
  ws.once('connect',()=>ws.write('GET '+url.pathname+' HTTP/1.1\\r\\nHost: '+url.host+'\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\nSec-WebSocket-Version: 13\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\nAuthorization: '+headers.Authorization+'\\r\\n\\r\\n'));
  ws.on('data',chunk=>{response+=chunk.toString();if(response.includes('\\r\\n\\r\\n'))response.startsWith('HTTP/1.1 101 ')?resolve():reject(new Error('Fixture relay handshake failed'));});
  ws.once('error',reject);
  void closed.then(()=>reject(new Error('Fixture relay closed during handshake')));
});
fs.writeFileSync(path.join(root,'setup'),id);
while(fs.existsSync(path.join(root,'hold-setup'))&&!relayClosed)await new Promise(resolve=>setTimeout(resolve,5));
const failed=()=>({isError:true,content:[{type:'text',text:'Fixture browser connection is unavailable'}]});
const server=new McpServer({name:'synthetic-chrome',version:'1'});
server.registerTool('identity',{inputSchema:{}},async()=>{
  if(relayClosed)return failed();
  fs.appendFileSync(path.join(root,'requests'),'identity\\n');
  return {content:[{type:'text',text:JSON.stringify({id,relay:true})}]};
});
server.registerTool('held_write',{inputSchema:{}},async()=>{
  if(relayClosed)return failed();
  fs.appendFileSync(path.join(root,'effects'),'write\\n');
  fs.writeFileSync(path.join(root,'held'),'entered');
  await closed;
  return failed();
});
await server.connect(new StdioServerTransport());
`;
}
