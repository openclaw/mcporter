import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readCliMetadata } from '../src/cli-metadata.js';
import { generateCli, __test as generateCliInternals } from '../src/generate-cli.js';
import type { ServerToolInfo } from '../src/runtime.js';

const describeGenerateCli = process.platform === 'win32' ? describe.skip : describe;

let baseUrl: URL;
const tmpDir = path.join(process.cwd(), 'tmp', 'mcporter-cli-tests');
const CLI_ENTRY = path.join(process.cwd(), 'dist', 'cli.js');

async function ensureDistBuilt(): Promise<void> {
  try {
    await fs.access(CLI_ENTRY);
  } catch {
    throw new Error('dist/cli.js is missing; run `pnpm build` before invoking this integration test directly.');
  }
}

if (process.platform !== 'win32') {
  beforeAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.mkdir(tmpDir, { recursive: true });
    const app = express();
    app.use(express.json());

    const server = new McpServer({ name: 'integration', version: '1.0.0' });
    server.registerTool(
      'add',
      {
        title: 'Add',
        description: 'Add two numbers',
        inputSchema: { a: z.number(), b: z.number() },
        outputSchema: { result: z.number() },
      },
      async ({ a, b }) => {
        const result = { result: Number(a) + Number(b) };
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
        };
      }
    );
    server.registerTool(
      'list_comments',
      {
        title: 'List Comments',
        description: 'List comments for an issue',
        inputSchema: { issueId: z.string() },
        outputSchema: { comments: z.array(z.string()) },
      },
      async ({ issueId }) => {
        const result = { comments: [`Comment for ${issueId}`] };
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
        };
      }
    );
    server.registerTool(
      'option_case_test',
      {
        title: 'Option Case Test',
        description: 'Tool with snake_case, camelCase, and numeric option names',
        inputSchema: {
          relative_path: z.string(),
          api_key: z.string(),
          tls_1_3: z.boolean(),
          issueId: z.string(),
        },
        outputSchema: { ok: z.boolean() },
      },
      async () => ({
        content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
        structuredContent: { ok: true },
      })
    );
    server.registerTool(
      'array_tool',
      {
        title: 'Array Tool',
        description: 'Tool with typed array inputs',
        inputSchema: {
          coords: z.array(z.number()),
          flags: z.array(z.boolean()),
          names: z.array(z.string()),
          ids: z.array(z.number().int()),
        },
        outputSchema: {
          coords: z.array(z.number()),
          flags: z.array(z.boolean()),
          names: z.array(z.string()),
          ids: z.array(z.number().int()),
        },
      },
      async ({ coords, flags, names, ids }) => ({
        content: [{ type: 'text', text: JSON.stringify({ coords, flags, names, ids }) }],
        structuredContent: { coords, flags, names, ids },
      })
    );
    server.registerTool(
      'object_tool',
      {
        title: 'Object Tool',
        description: 'Tool with object input',
        inputSchema: {
          fields: z.record(z.string(), z.unknown()),
        },
        outputSchema: {
          fields: z.record(z.string(), z.unknown()),
        },
      },
      async ({ fields }) => ({
        content: [{ type: 'text', text: JSON.stringify({ fields }) }],
        structuredContent: { fields },
      })
    );
    server.registerTool(
      'set_cells_batch',
      {
        title: 'Set Cells Batch',
        description: 'Set multiple cells in a single operation',
        inputSchema: {
          cells: z.array(
            z.object({
              x: z.number().int(),
              y: z.number().int(),
              char: z.string().min(1).max(1).optional(),
              color: z.string().optional(),
              bgColor: z.string().optional(),
            })
          ),
        },
        outputSchema: {
          cells: z.array(
            z.object({
              x: z.number(),
              y: z.number(),
              char: z.string().optional(),
            })
          ),
        },
      },
      async ({ cells }) => ({
        content: [{ type: 'text', text: JSON.stringify({ cells }) }],
        structuredContent: { cells },
      })
    );
    server.registerResource(
      'greeting',
      new ResourceTemplate('greeting://{name}', { list: undefined }),
      { title: 'Greeting', description: 'Simple greeting' },
      async (uri, { name }) => ({
        contents: [
          {
            uri: uri.href,
            text: `Hello, ${typeof name === 'string' ? name : 'friend'}!`,
          },
        ],
      })
    );

    app.post('/mcp', async (req, res) => {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => {
        transport.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });

    const httpServer = createServer(app);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to obtain test server address');
    }
    baseUrl = new URL(`http://127.0.0.1:${address.port}/mcp`);

    afterAll(async () => {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });
  });
}

describeGenerateCli('generateCli', () => {
  it('creates a standalone CLI and bundled executable', async () => {
    const inline = JSON.stringify({
      name: 'integration',
      description: 'Test integration server',
      command: baseUrl.toString(),
      tokenCacheDir: path.join(tmpDir, 'schema-cache'),
    });
    await fs.mkdir(path.join(tmpDir, 'schema-cache'), { recursive: true });
    const exec = await import('node:child_process');
    const bunAvailable = await hasBun(exec);
    if (!bunAvailable) {
      console.warn('bun is not available on this runner; skipping compilation checks.');
      return;
    }
    await ensureDistBuilt();

    const expectedBinaryPath = path.join(tmpDir, 'integration');
    const {
      outputPath: generated,
      bundlePath: bundled,
      compilePath,
    } = await generateCli({
      serverRef: inline,
      runtime: 'bun',
      timeoutMs: 5_000,
      minify: true,
      compile: expectedBinaryPath,
    });
    expect(bundled).toBeUndefined();
    if (!compilePath) {
      throw new Error('Expected compile output when --compile is provided');
    }
    expect(compilePath).toBe(expectedBinaryPath);

    // Template is only persisted when the caller supplies --output explicitly.
    const templateExists = await exists(generated);
    expect(templateExists).toBe(false);

    expect(await exists(compilePath)).toBe(true);

    const { stdout: defaultStdout } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      exec.execFile(
        compilePath,
        [],
        execOptions(),
        (error: import('node:child_process').ExecFileException | null, stdout: string, stderr: string) => {
          if (error) {
            reject(error);
            return;
          }
          resolve({ stdout, stderr });
        }
      );
    });
    expect(defaultStdout).toContain('Embedded tools');
    expect(defaultStdout).toContain('--a <a:number> --b <b:number>');

    const compileMetadata = await readCliMetadata(compilePath);
    expect(compileMetadata.artifact.kind).toBe('binary');
    expect(compileMetadata.artifact.path.endsWith(path.basename(compilePath))).toBe(true);
    expect(compileMetadata.invocation.compile).toBe(compilePath);
    expect(compileMetadata.server.name).toBe('integration');

    const packageJson = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      name?: string;
      version?: string;
    };
    const generatorLabel = `${packageJson.name ?? 'mcporter'}@${packageJson.version ?? 'unknown'}`;

    const { stdout: helpStdout } = await new Promise<{
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      exec.execFile(
        compilePath,
        ['--help'],
        execOptions(),
        (error: import('node:child_process').ExecFileException | null, stdout: string, stderr: string) => {
          if (error) {
            reject(error);
            return;
          }
          resolve({ stdout, stderr });
        }
      );
    });
    expect(helpStdout).toContain(`Generated by ${generatorLabel}`);
    expect(helpStdout).toContain('Embedded tools');
    expect(helpStdout).toContain('add - Add two numbers');
    expect(helpStdout).toContain('--a <a:number> --b <b:number>');
    expect(helpStdout).toContain('list-comments - List comments for an issue');

    // underscore alias should succeed after aliasing
    await new Promise<void>((resolve, reject) => {
      exec.execFile(
        compilePath,
        ['list_comments', '--issue-id', '42'],
        execOptions(),
        (error: import('node:child_process').ExecFileException | null, stdout: string) => {
          if (error) {
            reject(error);
            return;
          }
          expect(stdout).toContain('comments');
          resolve();
        }
      );
    });

    const { stdout: callStdout } = await new Promise<{
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      exec.execFile(
        compilePath,
        ['add', '--a', '2', '--b', '3', '--output', 'json'],
        execOptions(),
        (error: import('node:child_process').ExecFileException | null, stdout: string, stderr: string) => {
          if (error) {
            reject(error);
            return;
          }
          resolve({ stdout, stderr });
        }
      );
    });
    expect(callStdout).toContain('result');

    const cachePath = path.join(tmpDir, 'schema-cache', 'schema.json');
    const cacheRaw = await fs.readFile(cachePath, 'utf8');
    const cacheData = JSON.parse(cacheRaw) as {
      tools: Record<string, unknown>;
    };
    expect(Object.keys(cacheData.tools)).toEqual(expect.arrayContaining(['add', 'list_comments']));

    const derivedUrl = new URL(baseUrl.toString());
    derivedUrl.hostname = 'localhost';
    const altOutput = path.join(tmpDir, 'integration-alt.ts');
    const inlineServerDefinition = JSON.stringify({
      name: 'integration',
      description: 'Test integration server',
      command: derivedUrl.toString(),
      tokenCacheDir: path.join(tmpDir, 'schema-cache'),
    });
    await new Promise<void>((resolve, reject) => {
      exec.execFile(
        'node',
        ['dist/cli.js', 'generate-cli', '--server', inlineServerDefinition, '--output', altOutput],
        execOptions(),
        (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        }
      );
    });
    const altContent = await fs.readFile(altOutput, 'utf8');
    expect(altContent).toContain('const embeddedServer =');
    expect(altContent).toContain('const embeddedDescription = "Test integration server"');

    const altMetadata = await readCliMetadata(altOutput);
    expect(altMetadata.artifact.kind).toBe('template');
    expect(altMetadata.invocation.outputPath).toBe(altOutput);
    expect(['node', 'bun']).toContain(altMetadata.invocation.runtime);

    // --raw path exercised implicitly by runtime when needed; end-to-end call
    // verification is covered in runtime integration tests.
  }, 60_000);

  it('renders quick start examples from embedded tools', async () => {
    const inline = JSON.stringify({
      name: 'qs-demo',
      description: 'Quick start demo',
      command: baseUrl.toString(),
    });
    const outputPath = path.join(tmpDir, 'qs-demo.ts');
    await fs.rm(outputPath, { force: true });

    const { outputPath: renderedPath } = await generateCli({
      serverRef: inline,
      outputPath,
      runtime: 'node',
      timeoutMs: 5_000,
    });
    expect(renderedPath).toBe(outputPath);

    const { execFile } = await import('node:child_process');
    const { stdout } = await new Promise<{
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      execFile(
        'pnpm',
        ['exec', 'tsx', renderedPath, '--help'],
        execOptions(),
        (error: import('node:child_process').ExecFileException | null, helpStdout: string, stderr: string) => {
          if (error) {
            reject(error);
            return;
          }
          resolve({ stdout: helpStdout, stderr });
        }
      );
    });

    expect(stdout).toContain('Quick start');
    // Should show real tool names (kebab-cased) instead of placeholders.
    expect(stdout).toContain('qs-demo add');
    expect(stdout).toContain('qs-demo list-comments');
    expect(stdout).not.toContain('<tool> key=value');
  }, 30_000);

  it('maps CLI options to Commander camelCase properties', async () => {
    const inline = JSON.stringify({
      name: 'case-options',
      description: 'Case options test',
      command: baseUrl.toString(),
    });
    const outputPath = path.join(tmpDir, 'case-options.ts');
    await fs.rm(outputPath, { force: true });

    const { outputPath: renderedPath } = await generateCli({
      serverRef: inline,
      outputPath,
      runtime: 'node',
      timeoutMs: 5_000,
    });
    const content = await fs.readFile(renderedPath, 'utf8');

    expect(content).toContain('args.relative_path');
    expect(content).toContain('args.api_key');
    expect(content).toContain('args.tls_1_3');
    expect(content).toContain('args.issueId');
    expect(content).toContain('cmdOpts.relativePath');
    expect(content).toContain('cmdOpts.apiKey');
    expect(content).toContain('cmdOpts.tls13');
    expect(content).toContain('cmdOpts.issueId');
    expect(content).not.toContain('cmdOpts.relative_path');
    expect(content).not.toContain('cmdOpts.api_key');
    expect(content).not.toContain('cmdOpts.tls_1_3');
  });

  it('coerces array option values using schema item types', async () => {
    const inline = JSON.stringify({
      name: 'array-test',
      description: 'Array coercion test',
      command: baseUrl.toString(),
    });
    const outputPath = path.join(tmpDir, 'array-test.ts');
    await fs.rm(outputPath, { force: true });

    const { outputPath: renderedPath } = await generateCli({
      serverRef: inline,
      outputPath,
      runtime: 'node',
      timeoutMs: 5_000,
    });
    expect(renderedPath).toBe(outputPath);

    const { execFile } = await import('node:child_process');
    const { stdout } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(
        'pnpm',
        [
          'exec',
          'tsx',
          renderedPath,
          'array-tool',
          '--coords',
          '1, 2.5',
          '--flags',
          'true, false',
          '--names',
          'alpha, beta',
          '--ids',
          '1,2,3',
          '--output',
          'json',
        ],
        execOptions(),
        (error: import('node:child_process').ExecFileException | null, out: string, err: string) => {
          if (error) {
            reject(error);
            return;
          }
          resolve({ stdout: out, stderr: err });
        }
      );
    });
    const parsed = JSON.parse(stdout) as {
      coords: number[];
      flags: boolean[];
      names: string[];
      ids: number[];
    };
    expect(parsed.coords).toEqual([1, 2.5]);
    expect(parsed.flags).toEqual([true, false]);
    expect(parsed.names).toEqual(['alpha', 'beta']);
    expect(parsed.ids).toEqual([1, 2, 3]);
  }, 30_000);

  it('parses object option values as JSON in generated CLIs', async () => {
    const inline = JSON.stringify({
      name: 'object-test',
      description: 'Object parsing test',
      command: baseUrl.toString(),
    });
    const outputPath = path.join(tmpDir, 'object-test.ts');
    await fs.rm(outputPath, { force: true });

    const { outputPath: renderedPath } = await generateCli({
      serverRef: inline,
      outputPath,
      runtime: 'node',
      timeoutMs: 5_000,
    });
    const content = await fs.readFile(renderedPath, 'utf8');

    expect(content).toContain('--fields <fields:json>');
    expect(content).toContain('(value) => JSON.parse(value)');
    expect(content).toContain('"object-tool": "function object_tool(fields: Record<string, unknown>): object;"');

    const { execFile } = await import('node:child_process');
    const { stdout } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(
        'pnpm',
        [
          'exec',
          'tsx',
          renderedPath,
          'object-tool',
          '--fields',
          '{"summary":"Ship it","done":true}',
          '--output',
          'json',
        ],
        execOptions(),
        (error: import('node:child_process').ExecFileException | null, out: string, err: string) => {
          if (error) {
            reject(error);
            return;
          }
          resolve({ stdout: out, stderr: err });
        }
      );
    });

    expect(JSON.parse(stdout)).toEqual({
      fields: {
        done: true,
        summary: 'Ship it',
      },
    });
  }, 30_000);

  it('lets --raw bypass required generated flags', async () => {
    const inline = JSON.stringify({
      name: 'raw-required-test',
      description: 'Raw required test',
      command: baseUrl.toString(),
    });
    const outputPath = path.join(tmpDir, 'raw-required-test.ts');
    await fs.rm(outputPath, { force: true });

    const { outputPath: renderedPath } = await generateCli({
      serverRef: inline,
      outputPath,
      runtime: 'node',
      timeoutMs: 5_000,
      includeTools: ['set_cells_batch'],
    });
    const content = await fs.readFile(renderedPath, 'utf8');
    expect(content).toContain('.option("--cells <cells:value1,value2>"');
    expect(content).not.toContain('.requiredOption("--cells');

    const { execFile } = await import('node:child_process');
    const { stdout } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(
        'pnpm',
        [
          'exec',
          'tsx',
          renderedPath,
          'set-cells-batch',
          '--raw',
          '{"cells":[{"x":50,"y":15,"char":"A"}]}',
          '--output',
          'json',
        ],
        execOptions(),
        (error: import('node:child_process').ExecFileException | null, out: string, err: string) => {
          if (error) {
            reject(error);
            return;
          }
          resolve({ stdout: out, stderr: err });
        }
      );
    });

    expect(JSON.parse(stdout)).toEqual({
      cells: [{ char: 'A', x: 50, y: 15 }],
    });
  }, 30_000);

  it('parses generated array flags with JSON object items', async () => {
    const inline = JSON.stringify({
      name: 'array-object-test',
      description: 'Array object test',
      command: baseUrl.toString(),
    });
    const outputPath = path.join(tmpDir, 'array-object-test.ts');
    await fs.rm(outputPath, { force: true });

    const { outputPath: renderedPath } = await generateCli({
      serverRef: inline,
      outputPath,
      runtime: 'node',
      timeoutMs: 5_000,
      includeTools: ['set_cells_batch'],
    });
    const content = await fs.readFile(renderedPath, 'utf8');
    expect(content).toContain("parseArrayOption(value, 'json')");

    const { execFile } = await import('node:child_process');
    const { stdout } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(
        'pnpm',
        [
          'exec',
          'tsx',
          renderedPath,
          'set-cells-batch',
          '--cells',
          '{"x":50,"y":15,"char":"A"},{"x":51,"y":15,"char":"B"}',
          '--output',
          'json',
        ],
        execOptions(),
        (error: import('node:child_process').ExecFileException | null, out: string, err: string) => {
          if (error) {
            reject(error);
            return;
          }
          resolve({ stdout: out, stderr: err });
        }
      );
    });

    expect(JSON.parse(stdout)).toEqual({
      cells: [
        { char: 'A', x: 50, y: 15 },
        { char: 'B', x: 51, y: 15 },
      ],
    });
  }, 30_000);

  it('accepts both kebab-case and underscore tool names for generated CLIs', async () => {
    const deepwikiRef = JSON.stringify({
      name: 'deepwiki',
      description: 'DeepWiki MCP',
      command: 'https://mcp.deepwiki.com/mcp',
      tokenCacheDir: path.join(tmpDir, 'deepwiki-cache'),
    });
    const outputPath = path.join(tmpDir, 'deepwiki-cli.ts');
    await fs.rm(outputPath, { force: true });

    const { outputPath: renderedPath } = await generateCli({
      serverRef: deepwikiRef,
      outputPath,
      runtime: 'node',
      timeoutMs: 10_000,
    });
    expect(renderedPath).toBe(outputPath);

    const { execFile } = await import('node:child_process');

    const helpOutput = await new Promise<string>((resolve, reject) => {
      execFile(
        'pnpm',
        ['exec', 'tsx', renderedPath, '--help'],
        execOptions(),
        (error: import('node:child_process').ExecFileException | null, stdout: string) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(stdout);
        }
      );
    });

    expect(helpOutput).toMatch(/read-wiki-structure/);
    expect(helpOutput).not.toMatch(/read_wiki_structure/);

    // underscore alias should still work
    await new Promise<void>((resolve, reject) => {
      execFile(
        'pnpm',
        ['exec', 'tsx', renderedPath, 'read_wiki_structure', '--help'],
        execOptions(),
        (error: import('node:child_process').ExecFileException | null) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        }
      );
    });

    // canonical kebab name continues to work
    await new Promise<void>((resolve, reject) => {
      execFile(
        'pnpm',
        ['exec', 'tsx', renderedPath, 'read-wiki-structure', '--help'],
        execOptions(),
        (error: import('node:child_process').ExecFileException | null) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        }
      );
    });
  }, 40_000);
});

describe('generateCli helpers', () => {
  const { getEnumValues, getDescriptorDefault, buildPlaceholder, buildExampleValue, applyToolFilters } =
    generateCliInternals;

  it('extracts enum candidates from descriptors', () => {
    expect(getEnumValues({ type: 'string', enum: ['a', 'b', 1] })).toEqual(['a', 'b']);
    expect(
      getEnumValues({
        type: 'array',
        items: { type: 'string', enum: ['x', 'y'] },
      })
    ).toEqual(['x', 'y']);
    expect(getEnumValues({ type: 'number' })).toBeUndefined();
  });

  it('derives defaults, placeholders, and examples', () => {
    expect(getDescriptorDefault({ type: 'string', default: 'inline' })).toBe('inline');
    expect(
      getDescriptorDefault({
        type: 'array',
        items: { type: 'string' },
        default: ['first'],
      })
    ).toEqual(['first']);

    expect(buildPlaceholder('mode', 'string', ['read', 'write'])).toBe('<mode:read|write>');
    expect(buildExampleValue('mode', 'string', ['read', 'write'], undefined)).toBe('read');
    expect(buildPlaceholder('count', 'number')).toBe('<count:number>');
    expect(buildExampleValue('count', 'number', undefined, 3)).toBe('3');
    expect(buildExampleValue('path', 'string', undefined, undefined)).toBe('/path/to/file.md');
  });

  it('filters tools using include/exclude lists', () => {
    const tools: ServerToolInfo[] = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
    expect(applyToolFilters(tools, undefined, undefined).map((t) => t.name)).toEqual(['a', 'b', 'c']);
    expect(applyToolFilters(tools, ['b', 'a'], undefined).map((t) => t.name)).toEqual(['b', 'a']);
    expect(applyToolFilters(tools, undefined, ['b']).map((t) => t.name)).toEqual(['a', 'c']);
    expect(applyToolFilters(tools, undefined, ['missing']).map((t) => t.name)).toEqual(['a', 'b', 'c']);

    expect(() => applyToolFilters(tools, [], undefined)).toThrow(/--include-tools requires at least one/);
    expect(() => applyToolFilters(tools, undefined, [])).toThrow(/--exclude-tools requires at least one/);
    expect(() => applyToolFilters(tools, ['missing'], undefined)).toThrow(/Requested tools not found/);
    expect(() => applyToolFilters(tools, undefined, ['a', 'b', 'c'])).toThrow(/All tools were excluded/);
  });
});

async function exists(file: string | undefined): Promise<boolean> {
  if (!file) {
    return false;
  }
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function execOptions() {
  return {
    cwd: process.cwd(),
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
    encoding: 'utf8' as const,
  };
}

async function hasBun(exec: typeof import('node:child_process')) {
  return await new Promise<boolean>((resolve) => {
    exec.execFile(process.env.BUN_BIN ?? 'bun', ['--version'], execOptions(), (error) => {
      resolve(!error);
    });
  });
}
