import { privateFixtureDirectory } from './private-directory.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { DaemonClient, resolveDaemonPaths } from '../../src/daemon/client.js';
import { runDaemonHost } from '../../src/daemon/host.js';
import type { ServerDefinition } from '../../src/config.js';

export async function singletonFixture() {
  const root = await privateFixtureDirectory('mcp-broker-');
  const previous = process.env.MCPORTER_DAEMON_DIR;
  process.env.MCPORTER_DAEMON_DIR = root;
  const require = createRequire(import.meta.url);
  const script = path.join(root, 'fixture.mjs');
  await fs.writeFile(
    script,
    `import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { McpServer } from '${pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/mcp.js')).href}';
import { StdioServerTransport } from '${pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/stdio.js')).href}';
const id=randomUUID();let count=0;fs.appendFileSync(${JSON.stringify(path.join(root, 'instances'))},id+'\\n');
const server=new McpServer({name:'synthetic',version:'1'});
for(const name of ['identity','secret','delayed','application_error','disconnect'])server.registerTool(name,{inputSchema:{}},async()=>{
 count++; if(name==='disconnect')setTimeout(()=>process.exit(0),10); if(name==='delayed'){fs.appendFileSync(${JSON.stringify(path.join(root, 'effects'))},'once\\n');await new Promise(r=>setTimeout(r,250));}
 return name==='application_error'?{isError:true,content:[{type:'text',text:'synthetic tool error'}]}:{content:[{type:'text',text:JSON.stringify({id,count,value:process.env.VALUE,cwd:process.cwd()})}]};
});await server.connect(new StdioServerTransport());`
  );
  const definition: ServerDefinition = {
    name: 'fixture',
    command: { kind: 'stdio', command: process.execPath, args: [script], cwd: root },
    protocolVersion: 'legacy',
    lifecycle: { mode: 'keep-alive' },
    env: { VALUE: 'original' },
  };
  const paths = resolveDaemonPaths('');
  const host = await runDaemonHost({ ...paths, configPath: '' });
  const client = (def?: ServerDefinition) => {
    const c = new DaemonClient({ configPath: '' });
    c.setDefinitions([def ?? definition]);
    return c;
  };
  return {
    root,
    definition,
    paths,
    host,
    client,
    async close() {
      await host.close();
      if (previous === undefined) delete process.env.MCPORTER_DAEMON_DIR;
      else process.env.MCPORTER_DAEMON_DIR = previous;
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
export function fixtureResult(value: unknown): { id: string; count: number; value: string; cwd: string } {
  return JSON.parse((value as { content: Array<{ text: string }> }).content[0]!.text);
}
