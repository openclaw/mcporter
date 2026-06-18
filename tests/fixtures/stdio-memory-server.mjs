#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'memory-fixture', version: '1.0.0' });
const memory = new Set();

server.registerTool(
  'create_entities',
  {
    title: 'Create Entities',
    description: 'Insert the provided entity names into the in-memory store',
    inputSchema: {
      entities: z.array(z.string()),
    },
    outputSchema: {
      count: z.number(),
    },
  },
  async ({ entities }) => {
    for (const entity of entities) {
      if (entity.trim().length > 0) {
        memory.add(entity.trim());
      }
    }
    return {
      content: [{ type: 'text', text: `Stored ${memory.size} entities` }],
      structuredContent: { count: memory.size },
    };
  }
);

server.registerTool(
  'echo_text',
  {
    title: 'Echo Text',
    description: 'Return the provided text unchanged',
    inputSchema: {
      text: z.string(),
    },
    outputSchema: {
      text: z.string(),
    },
  },
  async ({ text }) => ({
    content: [{ type: 'text', text }],
    structuredContent: { text },
  })
);

server.registerTool(
  'list_entities',
  {
    title: 'List Entities',
    description: 'Return all previously stored entities',
    inputSchema: {},
    outputSchema: {
      entities: z.array(z.string()),
    },
  },
  async () => {
    return {
      content: [{ type: 'text', text: JSON.stringify(Array.from(memory)) }],
      structuredContent: { entities: Array.from(memory) },
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
await new Promise((resolve, reject) => {
  transport.onclose = resolve;
  transport.onerror = reject;
});
