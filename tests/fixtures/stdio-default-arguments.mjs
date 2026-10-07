import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const server = new Server({ name: 'default-proof', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'defaults',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', default: 0 },
          confirm: { type: 'boolean', default: false },
          text: { type: 'string', default: '' },
          needed: { type: 'string' },
        },
        required: ['limit', 'confirm', 'text', 'needed'],
      },
    },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{ type: 'text', text: JSON.stringify(request.params.arguments) }],
}));
await server.connect(new StdioServerTransport());
