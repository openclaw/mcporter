import path from 'node:path';
import type { ServerDefinition } from '../config.js';
import type { ToolDocModel } from './list-detail-helpers.js';

export interface ToolDocEntry {
  toolName: string;
  methodName: string;
  doc: ToolDocModel;
}

export interface EmitMetadata {
  server: ServerDefinition;
  generatorLabel: string;
  generatedAt: Date;
}

export interface EmitTypesTemplateInput {
  interfaceName: string;
  docs: ToolDocEntry[];
  metadata: EmitMetadata;
}

export interface EmitClientTemplateInput extends EmitTypesTemplateInput {
  typesImportPath: string;
}

export function renderTypesModule(input: EmitTypesTemplateInput): string {
  const lines: string[] = [];
  lines.push(...renderHeader(input.metadata));
  lines.push("import type { CallResult } from 'mcporter';");
  lines.push('');
  lines.push(`export interface ${input.interfaceName} {`);
  input.docs.forEach((entry, index) => {
    lines.push(...renderDocComment(entry.doc.docLines, '  '));
    const methodSignature = toInterfaceSignature(entry.doc.tsSignature, entry.toolName, { wrapInPromise: true });
    lines.push(`  ${methodSignature}`);
    if (entry.doc.optionalSummary) {
      lines.push(`  // ${entry.doc.optionalSummary.replace(/^\/\//, '').trim()}`);
    }
    if (index !== input.docs.length - 1) {
      lines.push('');
    }
  });
  if (input.docs.length === 0) {
    lines.push('  // No tools reported for this server.');
  }
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

export function renderClientModule(input: EmitClientTemplateInput): string {
  const lines: string[] = [];
  lines.push(...renderHeader(input.metadata));
  lines.push("import { createRuntime, createServerProxy, wrapCallResult } from 'mcporter';");
  lines.push(`import type { ${input.interfaceName} } from '${input.typesImportPath}';`);
  lines.push('');
  lines.push('type RuntimeInstance = Awaited<ReturnType<typeof createRuntime>>;');
  const clientType = `${input.interfaceName.replace(/Tools$/, 'Client')}`;
  const factoryName = `create${input.interfaceName.replace(/Tools$/, '')}Client`;
  const serverName = input.metadata.server.name;
  lines.push(`export type ${clientType} = ${input.interfaceName} & { close(): Promise<void> };`);
  lines.push('');
  lines.push('export interface CreateClientOptions {');
  lines.push('  runtime?: RuntimeInstance;');
  lines.push('  configPath?: string;');
  lines.push('  rootDir?: string;');
  lines.push('}');
  lines.push('');
  lines.push(`export async function ${factoryName}(options: CreateClientOptions = {}): Promise<${clientType}> {`);
  lines.push('  const runtime = options.runtime ?? (await createRuntime({');
  lines.push('    configPath: options.configPath,');
  lines.push('    rootDir: options.rootDir,');
  lines.push('  }));');
  lines.push('  const ownsRuntime = !options.runtime;');
  lines.push(`  const proxy = createServerProxy(runtime, ${JSON.stringify(serverName)});`);
  lines.push(`  const client: ${clientType} = {`);
  input.docs.forEach((entry, _index) => {
    const memberName = toMemberName(entry.toolName);
    const indexKey = toIndexKey(entry.toolName);
    lines.push(`    async ${memberName}(params: Parameters<${input.interfaceName}[${indexKey}]>[0]) {`);
    lines.push(
      `      const tool = proxy.${entry.methodName} as (args: Parameters<${input.interfaceName}[${indexKey}]>[0]) => Promise<unknown>;`
    );
    lines.push('      const raw = await tool(params);');
    lines.push('      return wrapCallResult(raw).callResult;');
    lines.push('    },');
    lines.push('');
  });
  lines.push('    async close() {');
  lines.push('      if (ownsRuntime) {');
  lines.push(`        await runtime.close(${JSON.stringify(serverName)}).catch(() => {});`);
  lines.push('      }');
  lines.push('    },');
  lines.push('  };');
  lines.push('  return client;');
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

function renderHeader(metadata: EmitMetadata): string[] {
  const lines: string[] = [];
  const timestamp = metadata.generatedAt.toISOString();
  lines.push(`// Generated on ${timestamp} by ${metadata.generatorLabel}`);
  if (metadata.server.description) {
    lines.push(`// Server: ${metadata.server.name} — ${metadata.server.description}`);
  } else {
    lines.push(`// Server: ${metadata.server.name}`);
  }
  const source = describeSource(metadata.server);
  if (source) {
    lines.push(`// Source: ${source}`);
  }
  const transport = describeTransport(metadata.server);
  if (transport) {
    lines.push(`// Transport: ${transport}`);
  }
  lines.push('');
  return lines;
}

function renderDocComment(docLines: string[] | undefined, indent: string): string[] {
  if (!docLines || docLines.length === 0) {
    return [];
  }
  return docLines.map((line) => `${indent}${line}`);
}

function toInterfaceSignature(signature: string, toolName: string, options?: { wrapInPromise?: boolean }): string {
  const trimmed = signature.trim();
  const match = trimmed.match(/^function\s+([^(]+)\((.*)\)\s*(?::\s*([^;]+))?;?$/);
  if (!match) {
    return trimmed.replace(/^function\s+/, '');
  }
  const [, , params, returnTypeRaw] = match;
  const returnType = (returnTypeRaw ?? 'void').trim();
  const finalReturn = options?.wrapInPromise ? `Promise<${returnType}>` : returnType;
  return `${toMemberName(toolName)}(${params}): ${finalReturn};`;
}

const SAFE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function toMemberName(name: string): string {
  return SAFE_IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

function toIndexKey(name: string): string {
  return JSON.stringify(name);
}

function describeTransport(definition: ServerDefinition): string | undefined {
  if (definition.command.kind === 'http') {
    const url = definition.command.url instanceof URL ? definition.command.url.href : String(definition.command.url);
    return `HTTP ${url}`;
  }
  if (definition.command.kind === 'stdio') {
    const cmd = [definition.command.command, ...(definition.command.args ?? [])].join(' ').trim();
    return cmd.length > 0 ? `STDIO ${cmd}` : 'STDIO';
  }
  return undefined;
}

function describeSource(definition: ServerDefinition): string | undefined {
  if (definition.source?.kind === 'import') {
    return path.normalize(definition.source.path);
  }
  if (definition.source?.kind === 'local') {
    return definition.source.path;
  }
  return undefined;
}
