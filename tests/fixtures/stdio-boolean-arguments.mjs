import fs from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const server = new Server({ name: 'boolean-proof', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'apply',
      inputSchema: {
        type: 'object',
        properties: {
          confirm: { type: 'boolean' },
          flags: { type: 'array', items: { type: 'boolean' } },
          nullableFlags: { type: 'array', items: { type: ['null', 'boolean'] } },
          mixedFlags: { type: 'array', items: { type: ['boolean', 'string'] } },
        },
      },
    },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  await fs.appendFile(process.env.CALL_LOG, JSON.stringify(request.params.arguments) + '\n');
  return { content: [{ type: 'text', text: JSON.stringify(request.params.arguments) }] };
});
await server.connect(new StdioServerTransport());
