import { createInterface } from 'node:readline';

const inputSchema = {
  type: 'object',
  properties: {
    labels: { anyOf: [{ type: 'array' }], allOf: [{ maxItems: 2 }] },
    mode: { anyOf: [{ type: 'string' }, { enum: ['auto'] }] },
    choice: { anyOf: [{ type: 'string' }, { const: 'auto' }] },
    nullable: { anyOf: [{ type: 'string' }, { const: null }] },
  },
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
        serverInfo: { name: 'schema-constraints-fixture', version: '1.0.0' },
      });
      break;
    case 'tools/list':
      respond(message.id, {
        resultType: 'complete',
        ttlMs: 0,
        cacheScope: 'private',
        tools: [{ name: 'echo', inputSchema }],
      });
      break;
    case 'tools/call':
      respond(message.id, {
        resultType: 'complete',
        content: [{ type: 'text', text: JSON.stringify(message.params.arguments) }],
      });
      break;
  }
});
