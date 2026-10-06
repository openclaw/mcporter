import path from 'node:path';
import type { ServerDefinition } from '../config.js';
import { isRecord } from '../config/imports/shared.js';
import type { ToolDocModel } from './list-detail-helpers.js';
import { formatParameterObjectType } from './list-signature.js';

export interface ToolDocEntry {
  toolName: string;
  methodName: string;
  doc: ToolDocModel;
  inputSchema?: unknown;
}

export interface EmitMetadata {
  server: ServerDefinition;
  generatorLabel: string;
  generatedAt: Date;
}

// `positional` is the `mcporter list` spelling that `--mode types` has always emitted; `object`
// is the one-arguments-object form the generated client implements.
export type SignatureStyle = 'positional' | 'object';

export interface EmitTypesTemplateInput {
  interfaceName: string;
  docs: ToolDocEntry[];
  metadata: EmitMetadata;
  signatureStyle: SignatureStyle;
}

export type EmitClientTemplateInput = Omit<EmitTypesTemplateInput, 'signatureStyle'>;

export function renderTypesModule(input: EmitTypesTemplateInput): string {
  const lines: string[] = [];
  lines.push(...renderHeader(input.metadata));
  lines.push("import type { CallResult } from 'mcporter';");
  lines.push('');
  lines.push(...renderInterface(input));
  lines.push('');
  return lines.join('\n');
}

export function renderClientModule(input: EmitClientTemplateInput): string {
  const reserved = input.docs.find(({ toolName }) => toolName === 'close' || toolName === 'then');
  if (reserved) {
    throw new Error(
      `Cannot emit client for tool '${reserved.toolName}': the name conflicts with client lifecycle or Promise resolution. Use runtime.callTool() to invoke this tool.`
    );
  }
  const lines: string[] = [];
  lines.push(...renderHeader(input.metadata));
  lines.push("import { type CallResult, createRuntime, createServerProxy } from 'mcporter';");
  lines.push('');
  lines.push('type RuntimeInstance = Awaited<ReturnType<typeof createRuntime>>;');
  lines.push('');
  // The interface lives in this file so the client compiles wherever the `.d.ts` sits: a sibling
  // `<name>.d.ts` is the declaration TypeScript pairs with `<name>.ts`, so importing it from
  // here would resolve to this module.
  lines.push(...renderInterface({ ...input, signatureStyle: 'object' }));
  lines.push('');
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
  // Dynamic methods retain the proxy's schema defaults and required-argument validation.
  lines.push(
    `  const tools = proxy as typeof proxy & { [K in keyof ${input.interfaceName}]: (params: unknown) => Promise<CallResult> };`
  );
  lines.push(`  const client: ${clientType} = {`);
  input.docs.forEach((entry) => {
    const memberName = toMemberName(entry.toolName);
    const access = toMemberAccess(entry.toolName);
    lines.push(`    async ${memberName}(params) {`);
    if (entry.toolName === 'call' || entry.toolName === 'listTools') {
      lines.push(
        `      const toolProxy = createServerProxy(runtime, ${JSON.stringify(serverName)}, () => ${JSON.stringify(entry.toolName)});`
      );
      lines.push('      const invoke = Reflect.get(toolProxy, Symbol()) as (params: unknown) => Promise<CallResult>;');
      lines.push('      return invoke(params === undefined ? {} : params);');
    } else {
      lines.push(`      return tools${access}(params === undefined ? {} : params);`);
    }
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

function renderInterface(input: EmitTypesTemplateInput): string[] {
  const lines: string[] = [];
  lines.push(`export interface ${input.interfaceName} {`);
  input.docs.forEach((entry, index) => {
    lines.push(...renderDocComment(entry.doc.docLines, '  '));
    lines.push(`  ${toInterfaceSignature(entry, input.signatureStyle)}`);
    if (entry.doc.optionalSummary) {
      lines.push(`  // ${singleCommentLine(entry.doc.optionalSummary.replace(/^\/\//, '').trim())}`);
    }
    if (index !== input.docs.length - 1) {
      lines.push('');
    }
  });
  if (input.docs.length === 0) {
    lines.push('  // No tools reported for this server.');
  }
  lines.push('}');
  return lines;
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
  return lines.map(singleCommentLine);
}

function singleCommentLine(text: string): string {
  return text.replace(/[\r\n\u2028\u2029]/g, ' ');
}

function renderDocComment(docLines: string[] | undefined, indent: string): string[] {
  if (!docLines || docLines.length === 0) {
    return [];
  }
  return docLines.map(
    (line, index) => `${indent}${index === 0 || index === docLines.length - 1 ? line : line.replaceAll('*/', '* /')}`
  );
}

const SIGNATURE_PATTERN = /^function\s+([^(]+)\((.*)\)\s*(?::\s*([^;]+))?;?$/;

function toInterfaceSignature(entry: ToolDocEntry, style: SignatureStyle): string {
  if (style === 'object') {
    return `${toMemberName(entry.toolName)}(${toObjectParams(entry)}): Promise<CallResult>;`;
  }
  const trimmed = entry.doc.tsSignature.trim();
  const match = trimmed.match(SIGNATURE_PATTERN);
  if (!match) {
    return trimmed.replace(/^function\s+/, '');
  }
  const [, , positionalParams, returnTypeRaw] = match;
  const returnType = (returnTypeRaw ?? 'void').trim();
  return `${toMemberName(entry.toolName)}(${positionalParams}): Promise<${returnType}>;`;
}

// Empty display metadata can still describe map or composed schemas that accept arguments.
function toObjectParams(entry: ToolDocEntry): string {
  const schema = entry.inputSchema;
  const closed =
    isRecord(schema) &&
    (schema.additionalProperties === false ||
      (schema.additionalProperties === undefined && schema.unevaluatedProperties === false));
  const patterns =
    isRecord(schema) && isRecord(schema.patternProperties) && Object.keys(schema.patternProperties).length > 0;
  const composed =
    isRecord(schema) &&
    schema.additionalProperties !== false &&
    ['$ref', 'allOf', 'anyOf', 'oneOf', 'if', 'then', 'else', 'dependentSchemas'].some((key) =>
      Object.hasOwn(schema, key)
    );
  const extraKeys = !closed || patterns || composed;
  let parameterType = formatParameterObjectType(entry.doc.displayOptions);
  if (!parameterType) return `params?: Record<string, ${extraKeys ? 'unknown' : 'never'}>`;
  if (extraKeys) parameterType += ' & Record<string, unknown>';
  const optionalSuffix = entry.doc.displayOptions.some((option) => option.required) ? '' : '?';
  return `params${optionalSuffix}: ${parameterType}`;
}

const SAFE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function toMemberName(name: string): string {
  return SAFE_IDENTIFIER.test(name) && name !== 'new' ? name : JSON.stringify(name);
}

function toMemberAccess(name: string): string {
  return SAFE_IDENTIFIER.test(name) ? `.${name}` : `[${JSON.stringify(name)}]`;
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
