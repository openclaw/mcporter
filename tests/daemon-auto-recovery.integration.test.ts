import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { ownedProcessTree } from '../src/daemon/process-retirement.js';
import { privateFixtureDirectory } from './helpers/private-directory.js';
import { ensureDistBuilt } from './helpers/dist.js';
import { budget } from './helpers/timing.js';

const exec = promisify(execFile);
const cliEntry = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const require = createRequire(import.meta.url);

const ownerModule = pathToFileURL(fileURLToPath(new URL('../dist/daemon/managed-owner.js', import.meta.url))).href;

const module = (name: string) => pathToFileURL(require.resolve(`@modelcontextprotocol/sdk/server/${name}.js`)).href;

async function fixture() {
  await ensureDistBuilt(cliEntry);
  const root = await fs.realpath(await privateFixtureDirectory('mcp-auto-'));
  const script = path.join(root, 'fixture.mjs');

  await fs.writeFile(
    script,
    `import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { McpServer } from '${module('mcp')}';
import { StdioServerTransport } from '${module('stdio')}';
const id=randomUUID();const server=new McpServer({name:'fixture',version:'1'});
fs.appendFileSync(${JSON.stringify(path.join(root, 'launches'))},id+'\\n');
server.registerTool('identity',{inputSchema:{}},async()=>({content:[{type:'text',text:JSON.stringify({id,pid:process.pid})}]}));
server.registerTool('effect',{inputSchema:{}},async()=>{fs.appendFileSync(${JSON.stringify(path.join(root, 'effects'))},'once\\n');await new Promise(()=>{});return {content:[{type:'text',text:'done'}]};});
await server.connect(new StdioServerTransport());`
  );
  const config = path.join(root, 'config.json');
  await fs.writeFile(
    config,
    JSON.stringify({
      imports: [],
      mcpServers: {
        fixture: { command: process.execPath, args: [script], protocolVersion: 'legacy', lifecycle: 'keep-alive' },
      },
    })
  );
  const cli = (args: string[]) =>
    exec(process.execPath, [cliEntry, '--config', config, ...args], {
      env: { ...process.env, MCPORTER_DAEMON_DIR: root, MCPORTER_OAUTH_NO_BROWSER: '1' },
      timeout: budget(70_000),
    }).catch((error: Error & { stderr?: string }) => {
      throw new Error(`${error.message} ${error.stderr ?? ''}`, { cause: error });
    });
  const call = async () => JSON.parse((await cli(['call', 'fixture.identity', '--output', 'json'])).stdout);
  const status = async () => JSON.parse((await cli(['daemon', 'status', '--json'])).stdout);
  return {
    root,
    cli,
    call,
    status,
    async close() {
      // Keep ownership evidence if retirement fails; never hide a leaked fixture behind rm.
      await exec(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
        import fs from 'node:fs/promises';
        import { retireManagedOwner } from ${JSON.stringify(ownerModule)};
        const state=JSON.parse(await fs.readFile(${JSON.stringify(path.join(root, 'daemon', 'lifecycle.json'))},'utf8'));
        if(state.active?.identity) await retireManagedOwner(state.active);
      `,
        ],
        { env: { ...process.env, MCPORTER_DAEMON_DIR: root }, timeout: budget(45_000) }
      );
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

it(
  'automatically replaces a killed daemon once for concurrent fresh CLI clients',
  async () => {
    const f = await fixture();
    try {
      const initial = await f.call();
      const old = await f.status();
      const tree = await ownedProcessTree(old.pid);
      expect((await ownedProcessTree(old.pid))[0]).toEqual(tree[0]);
      process.kill(old.pid, 'SIGKILL');
      const results = await Promise.all(Array.from({ length: 4 }, () => f.call()));
      const current = await f.status();
      expect(current.generation).not.toBe(old.generation);
      expect(new Set(results.map((result) => result.id)).size).toBe(1);
      expect(results[0].id).not.toBe(initial.id);
      expect((await fs.readFile(path.join(f.root, 'launches'), 'utf8')).trim().split('\n')).toHaveLength(2);
    } finally {
      await f.close();
    }
  },
  budget(100_000)
);

it(
  'does not replay an operation interrupted after its effect when another client recovers the daemon',
  async () => {
    const f = await fixture();
    let interrupted: Promise<unknown> | undefined;
    try {
      await f.call();
      const old = await f.status();
      interrupted = f.cli(['call', 'fixture.effect']).then(
        () => 'unexpected success',
        () => 'failed'
      );
      for (let attempt = 0; ; attempt++) {
        const effect = await fs.readFile(path.join(f.root, 'effects'), 'utf8').catch(() => '');
        if (effect) break;
        if (attempt >= 300) throw new Error('Fixture effect did not happen.');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const tree = await ownedProcessTree(old.pid);
      expect((await ownedProcessTree(old.pid))[0]).toEqual(tree[0]);
      process.kill(old.pid, 'SIGKILL');
      expect(await interrupted).toBe('failed');
      await f.call();
      expect((await fs.readFile(path.join(f.root, 'effects'), 'utf8')).trim().split('\n')).toEqual(['once']);
    } finally {
      await f.close();
      await interrupted;
    }
  },
  budget(100_000)
);
