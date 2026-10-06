import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'replay-id-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
let releaseNumeric;
const stringHandled = new Promise((resolve) => {
  releaseNumeric = resolve;
});
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'numeric') {
    await stringHandled;
    // Let the string response reach stdout before the numeric response.
    await new Promise((resolve) => setTimeout(resolve, 10));
  } else {
    releaseNumeric();
  }
  return { content: [{ type: 'text', text: `${request.params.name}-response` }] };
});
await server.connect(new StdioServerTransport());
