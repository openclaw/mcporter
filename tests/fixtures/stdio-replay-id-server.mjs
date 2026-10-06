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
  }
  return { content: [{ type: 'text', text: `${request.params.name}-response` }] };
});
const transport = new StdioServerTransport();
const send = transport.send.bind(transport);
transport.send = async (message) => {
  await send(message);
  if ('id' in message && message.id === '1' && 'result' in message) releaseNumeric();
};
await server.connect(transport);
