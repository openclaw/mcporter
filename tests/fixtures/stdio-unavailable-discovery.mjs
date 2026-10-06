import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
const server = new Server({ name: 'discovery-unavailable', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => {
  throw new McpError(ErrorCode.MethodNotFound, 'Discovery unavailable');
});
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'delayed') await new Promise((resolve) => setTimeout(resolve, 5000));
  return { content: [{ type: 'text', text: JSON.stringify(request.params.arguments ?? {}) }] };
});
await server.connect(new StdioServerTransport());
