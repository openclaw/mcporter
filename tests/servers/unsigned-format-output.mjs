import { createInterface } from 'node:readline';

const outputSchema = {
  ...(process.argv[2] ? { $schema: process.argv[2] } : {}),
  type: 'object',
  anyOf: [
    {
      type: 'object',
      properties: {
        apps: {
          type: 'array',
          items: {
            type: 'object',
            properties: { pid: { type: 'integer', format: 'uint32', minimum: 0, maximum: 4294967295 } },
            required: ['pid'],
          },
        },
        window_id: { type: 'integer', format: 'uint64', minimum: 0 },
        timestamp: { type: 'string', format: 'date-time' },
      },
      required: ['apps', 'window_id', 'timestamp'],
      additionalProperties: false,
    },
  ],
};

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  switch (message.method) {
    case 'server/discover':
      respond(message.id, { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } });
      break;
    case 'initialize':
      respond(message.id, {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'unsigned-format-fixture', version: '1.0.0' },
      });
      break;
    case 'tools/list':
      respond(message.id, {
        tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} }, outputSchema }],
      });
      break;
    case 'tools/call':
      respond(message.id, { content: [], structuredContent: message.params.arguments });
      break;
  }
});
