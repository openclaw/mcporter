import fs from 'node:fs/promises';
import path from 'node:path';
import {
  bundleOutput,
  compileBundleWithBun,
  computeCompileTarget,
  resolveBundleTarget,
} from './cli/generate/artifacts.js';
import { ensureInvocationDefaults, fetchTools, resolveServerDefinition } from './cli/generate/definition.js';
import { resolveRuntimeKind } from './cli/generate/runtime.js';
import { readPackageMetadata, writeTemplate } from './cli/generate/template.js';
import type { ToolMetadata } from './cli/generate/tools.js';
import { buildToolMetadata, toolsTestHelpers } from './cli/generate/tools.js';
import { type CliArtifactMetadata, serializeDefinition } from './cli-metadata.js';
import type { ServerToolInfo } from './runtime.js';

export interface GenerateCliOptions {
  readonly serverRef: string;
  readonly configPath?: string;
  readonly rootDir?: string;
  readonly outputPath?: string;
  readonly runtime?: 'node' | 'bun';
  readonly bundler?: 'rolldown' | 'bun';
  readonly bundle?: boolean | string;
  readonly timeoutMs?: number;
  readonly minify?: boolean;
  readonly compile?: boolean | string;
  readonly includeTools?: string[];
  readonly excludeTools?: string[];
}

// generateCli produces a standalone CLI (and optional bundle/binary) for a given MCP server.
export async function generateCli(
  options: GenerateCliOptions
): Promise<{ outputPath: string; bundlePath?: string; compilePath?: string }> {
  const runtimeKind = await resolveRuntimeKind(options.runtime, options.compile);
  const bundlerKind = options.bundler ?? (runtimeKind === 'bun' ? 'bun' : 'rolldown');
  if (bundlerKind === 'bun' && runtimeKind !== 'bun') {
    throw new Error('--bundler bun currently requires --runtime bun.');
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  const { definition: baseDefinition, name } = await resolveServerDefinition(
    options.serverRef,
    options.configPath,
    options.rootDir
  );
  const { tools: allTools, derivedDescription } = await fetchTools(
    baseDefinition,
    name,
    options.configPath,
    options.rootDir
  );
  const tools = applyToolFilters(allTools, options.includeTools, options.excludeTools);
  const definition =
    baseDefinition.description || !derivedDescription
      ? baseDefinition
      : { ...baseDefinition, description: derivedDescription };
  const toolMetadata: ToolMetadata[] = tools.map((tool) => buildToolMetadata(tool));
  const generator = await readPackageMetadata();
  const baseInvocation = ensureInvocationDefaults(
    {
      serverRef: options.serverRef,
      configPath: options.configPath,
      rootDir: options.rootDir,
      runtime: runtimeKind,
      bundler: bundlerKind,
      outputPath: options.outputPath,
      bundle: options.bundle,
      compile: options.compile,
      timeoutMs,
      minify: options.minify ?? false,
      includeTools: options.includeTools,
      excludeTools: options.excludeTools,
    },
    definition
  );
  const embeddedMetadata: CliArtifactMetadata = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    generator,
    server: {
      name,
      source: definition.source,
      definition: serializeDefinition(definition),
    },
    artifact: {
      path: '',
      kind: 'template',
    },
    invocation: baseInvocation,
  };

  const shouldBundle = Boolean(options.bundle ?? options.compile);
  let templateTmpDir: string | undefined;
  let templateOutputPath = options.outputPath;
  if (!templateOutputPath && shouldBundle) {
    const tmpPrefix = path.join(process.cwd(), 'tmp', 'mcporter-cli-');
    await fs.mkdir(path.dirname(tmpPrefix), { recursive: true });
    templateTmpDir = await fs.mkdtemp(tmpPrefix);
    templateOutputPath = path.join(templateTmpDir, `${name}.ts`);
  }
  const templateSourcePath = path.resolve(templateOutputPath ?? path.resolve(process.cwd(), `${name}.ts`));
  let resolvedBundleTarget: string | undefined;
  let resolvedCompileTarget: string | undefined;
  if (shouldBundle) {
    resolvedBundleTarget = path.resolve(
      resolveBundleTarget({
        bundle: options.bundle,
        compile: options.compile,
        outputPath: templateSourcePath,
      })
    );
    if (options.compile) {
      resolvedCompileTarget = path.resolve(computeCompileTarget(options.compile, resolvedBundleTarget, name));
    }
  }
  const runtimeScriptPath = resolvedCompileTarget ?? resolvedBundleTarget ?? templateSourcePath;

  const outputPath = await writeTemplate({
    outputPath: templateOutputPath,
    runtimeScriptPath,
    runtimeKind,
    timeoutMs,
    definition,
    serverName: name,
    tools: toolMetadata,
    generator,
    metadata: embeddedMetadata,
  });

  let bundlePath: string | undefined;
  let compilePath: string | undefined;

  try {
    if (shouldBundle && resolvedBundleTarget) {
      bundlePath = await bundleOutput({
        sourcePath: outputPath,
        runtimeKind,
        targetPath: resolvedBundleTarget,
        minify: options.minify ?? false,
        bundler: bundlerKind,
      });

      if (options.compile) {
        if (runtimeKind !== 'bun') {
          throw new Error('--compile is only supported when --runtime bun');
        }
        const compileTarget = resolvedCompileTarget ?? computeCompileTarget(options.compile, bundlePath, name);
        await compileBundleWithBun(bundlePath, compileTarget);
        compilePath = compileTarget;
        if (!options.bundle) {
          await fs.rm(bundlePath).catch(() => {});
          bundlePath = undefined;
        }
      }
    }
  } finally {
    if (templateTmpDir) {
      await fs.rm(templateTmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  return { outputPath: options.outputPath ?? outputPath, bundlePath, compilePath };
}

function applyToolFilters(tools: ServerToolInfo[], includeTools?: string[], excludeTools?: string[]): ServerToolInfo[] {
  if (includeTools && excludeTools) {
    throw new Error('Internal error: both includeTools and excludeTools provided to generateCli.');
  }
  if (includeTools && includeTools.length === 0) {
    throw new Error('--include-tools requires at least one tool name.');
  }
  if (excludeTools && excludeTools.length === 0) {
    throw new Error('--exclude-tools requires at least one tool name.');
  }

  if (!includeTools && !excludeTools) {
    return tools;
  }

  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));

  if (includeTools && includeTools.length > 0) {
    const result: ServerToolInfo[] = [];
    const missing: string[] = [];

    for (const name of includeTools) {
      const match = toolMap.get(name);
      if (match) {
        result.push(match);
      } else {
        missing.push(name);
      }
    }

    if (missing.length > 0) {
      throw new Error(
        `Requested tools not found on server: ${missing.join(', ')}. Available tools: ${tools.map((tool) => tool.name).join(', ')}`
      );
    }

    if (result.length === 0) {
      throw new Error('No tools remain after applying --include-tools filter.');
    }

    return result;
  }

  if (excludeTools && excludeTools.length > 0) {
    const excludeSet = new Set(excludeTools);
    const filtered = tools.filter((tool) => !excludeSet.has(tool.name));
    if (filtered.length === 0) {
      throw new Error(
        `All tools were excluded. Exclude list: ${[...excludeSet].join(', ')}. Available tools: ${tools.map((tool) => tool.name).join(', ')}`
      );
    }
    return filtered;
  }

  return tools;
}

export const __test = { ...toolsTestHelpers, applyToolFilters };
