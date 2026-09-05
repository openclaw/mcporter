import { privateFixtureDirectory } from './helpers/private-directory.js';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

// Keep the same broker throughout, without putting unrelated CLI contracts under one deadline.
describe('shared singleton CLI workflow', { concurrent: false }, () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  let configs: string[] = [];
  let initialResults: Array<{ id: string }>;
  let initialHost: { pid: number; protocolVersion: number; servers: unknown[] };
  let initialLaunchCount: number;
  const inFlight = new Set<Promise<unknown>>();
  const invoke = async (config: string, args: string[], extra = {}, callerCwd = root) => {
    const launchEnv: NodeJS.ProcessEnv = { ...env, ...extra };
    delete launchEnv.PWD;
    const argv = [cli, '--config', config, ...args];
    const operation = run(
      process.platform === 'win32' ? process.execPath : '/bin/sh',
      process.platform === 'win32' ? argv : ['-c', 'exec "$@"', 'fixture-launcher', process.execPath, ...argv],
      { env: launchEnv, cwd: callerCwd, timeout: 15000 }
    );
    inFlight.add(operation);
    try {
      return (await operation).stdout;
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string };
      throw new Error(`${failure.message} ${failure.stdout} ${failure.stderr}`, { cause: error });
    } finally {
      inFlight.delete(operation);
    }
  };
  const status = async () => JSON.parse(await invoke(configs[0]!, ['daemon', 'status', '--json']));
  const call = async (index: number, tool = 'identity', extra = {}) =>
    JSON.parse(
      await invoke(configs[index]!, ['call', `${['one', 'two', 'three'][index]}.${tool}`, '--output', 'json'], extra)
    );
  const launches = async () => (await fs.readFile(path.join(root, 'launches'), 'utf8')).trim().split('\n');

  beforeAll(async () => {
    root = await privateFixtureDirectory('mcp-one-');
    env = { ...process.env, HOME: root, USERPROFILE: root, MCPORTER_DAEMON_DIR: root, MCPORTER_NO_FORCE_EXIT: '1' };
    const fixture = path.join(root, 'fixture.mjs');
    await fs.writeFile(
      fixture,
      `import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { McpServer } from '${pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/mcp.js')).href}';
import { StdioServerTransport } from '${pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/stdio.js')).href}';
const id = randomUUID(); let calls = 0;
fs.appendFileSync(${JSON.stringify(path.join(root, 'launches'))}, id+'\\n');
const server = new McpServer({name:'fixture', version:'1'});
for (const name of ['identity', 'secret']) server.registerTool(name, {inputSchema:{}}, async () => ({content:[{type:'text',text:JSON.stringify({id,calls:++calls, token:process.env.FIXTURE_TOKEN})}]}));
server.registerTool('delayed', { inputSchema:{} }, async () => { fs.appendFileSync(${JSON.stringify(path.join(root, 'effects'))}, 'once\\n'); await new Promise((r) => setTimeout(r, 1000)); return {content:[{type:'text',text:'done'}]}; });
await server.connect(new StdioServerTransport());
`
    );
    configs = await Promise.all(
      ['one', 'two', 'three'].map(async (alias) => {
        const config = path.join(root, `${alias}.json`);
        await fs.writeFile(
          config,
          JSON.stringify({
            imports: [],
            mcpServers: {
              [alias]: {
                command: process.execPath,
                args: [fixture],
                cwd: root,
                protocolVersion: 'legacy',
                env: { FIXTURE_TOKEN: 'same' },
                lifecycle: 'keep-alive',
                ...(alias === 'two' ? { blockedTools: ['secret'] } : {}),
              },
            },
          })
        );
        return config;
      })
    );
    initialResults = await Promise.all([call(0), call(1), call(2)]);
    initialHost = await status();
    initialLaunchCount = (await launches()).length;
  });

  afterAll(async () => {
    await Promise.allSettled(inFlight);
    if (configs.length) await invoke(configs[0]!, ['daemon', 'stop']);
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it('shares one host and child across concurrent cold config views', () => {
    expect(new Set(initialResults.map((value) => value.id)).size).toBe(1);
    expect(initialHost.servers).toHaveLength(1);
    expect(initialHost.protocolVersion).toBe(3);
    expect(initialLaunchCount).toBe(1);
  });

  it('retains the child across fresh callers and caller directories', async () => {
    const before = await launches();
    expect((await call(0)).id).toBe(initialResults[0]!.id);
    const callerB = path.join(root, 'caller-b');
    await fs.mkdir(callerB);
    const fromOtherCwd = JSON.parse(
      await invoke(configs[0]!, ['call', 'one.identity', '--output', 'json'], {}, callerB)
    );
    expect(fromOtherCwd.id).toBe(initialResults[0]!.id);
    expect((await call(0)).id).toBe(initialResults[0]!.id);
    expect(await launches()).toEqual(before);
  });

  it('ignores an inherited value overridden by the shared definition', async () => {
    const before = await launches();
    expect((await call(1, 'identity', { FIXTURE_TOKEN: 'overridden' })).id).toBe(initialResults[0]!.id);
    expect(await launches()).toEqual(before);
  });

  it('enforces per-view permissions without replacing the shared owner', async () => {
    const before = await launches();
    await expect(call(1, 'secret')).rejects.toThrow(/blocked by configuration/);
    expect((await call(0, 'secret')).id).toBe(initialResults[0]!.id);
    const limited = await invoke(configs[1]!, ['list', 'two', '--json']);
    expect(limited).not.toContain('"name": "secret"');
    expect(limited).toContain('identity');
    expect((await status()).pid).toBe(initialHost.pid);
    expect(await launches()).toEqual(before);
  });

  it('isolates changed server environment while retaining the original child', async () => {
    const third = JSON.parse(await fs.readFile(configs[2]!, 'utf8'));
    third.mcpServers.three.env.FIXTURE_TOKEN = 'changed';
    third.mcpServers.three.cwd = root;
    await fs.writeFile(configs[2]!, JSON.stringify(third));
    const changed = await call(2);
    expect(changed.token).toBe('changed');
    expect(changed.id).not.toBe(initialResults[0]!.id);
    expect((await call(0)).id).toBe(initialResults[0]!.id);
  });

  it('isolates changed child cwd without restarting the host', async () => {
    const third = JSON.parse(await fs.readFile(configs[2]!, 'utf8'));
    third.mcpServers.three.env.FIXTURE_TOKEN = 'changed';
    third.mcpServers.three.cwd = root;
    await fs.writeFile(configs[2]!, JSON.stringify(third));
    const changed = await call(2);
    const newCwd = path.join(root, 'cwd');
    await fs.mkdir(newCwd);
    third.mcpServers.three.cwd = newCwd;
    await fs.writeFile(configs[2]!, JSON.stringify(third));
    expect((await call(2)).id).not.toBe(changed.id);
    expect((await status()).pid).toBe(initialHost.pid);
    expect(await launches()).toHaveLength(3);
  });

  it('does not replay an uncertain CLI call or replace its owner', async () => {
    const before = await launches();
    await expect(invoke(configs[0]!, ['call', 'one.delayed', '--timeout', '50', '--output', 'json'])).rejects.toThrow();
    expect((await fs.readFile(path.join(root, 'effects'), 'utf8')).trim().split('\n')).toEqual(['once']);
    expect((await status()).pid).toBe(initialHost.pid);
    expect(await launches()).toEqual(before);
  });
});
