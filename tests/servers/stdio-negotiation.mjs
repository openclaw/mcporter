import { createInterface } from 'node:readline';

const mode = process.argv[2];
if (mode !== 'legacy-exit' && mode !== 'modern') {
  throw new Error("Expected negotiation fixture mode 'legacy-exit' or 'modern'.");
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'server/discover') {
    if (mode === 'legacy-exit') {
      process.exit(0);
    }
    respond(message.id, {
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {} },
    });
    return;
  }

  if (message.method === 'initialize') {
    respond(message.id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'stdio-negotiation-fixture', version: '1.0.0' },
    });
    return;
  }

  if (message.method === 'tools/list') {
    respond(message.id, {
      ...(mode === 'modern' ? { resultType: 'complete', ttlMs: 0, cacheScope: 'private' } : {}),
      tools: [
        {
          name: mode === 'modern' ? 'modern_ping' : 'legacy_ping',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    });
  }
});
