import { readCliMetadata } from '../cli-metadata.js';
import type { FlagMap } from './flag-utils.js';
import { parseGenerateFlags } from './generate/flags.js';
import { inferNameFromCommand } from './generate/name-utils.js';
import { performGenerateFromArtifact, performGenerateFromRequest } from './generate/output.js';
import { buildInlineServerDefinition } from './generate/server-utils.js';
import { buildGenerateCliCommand, resolveGenerateRequestFromArtifact } from './generate/template-data.js';

// handleGenerateCli parses flags and generates the requested standalone CLI.
export async function handleGenerateCli(args: string[], globalFlags: FlagMap): Promise<void> {
  const parsed = parseGenerateFlags(args);
  if (parsed.includeTools && parsed.excludeTools) {
    throw new Error('--include-tools and --exclude-tools cannot be used together.');
  }
  if (parsed.includeTools && parsed.includeTools.length === 0) {
    throw new Error('--include-tools requires at least one tool name.');
  }
  if (parsed.excludeTools && parsed.excludeTools.length === 0) {
    throw new Error('--exclude-tools requires at least one tool name.');
  }
  if (parsed.from && (parsed.command || parsed.description || parsed.name)) {
    throw new Error('--from cannot be combined with --command/--description/--name.');
  }
  if (parsed.dryRun && !parsed.from) {
    throw new Error('--dry-run currently requires --from <artifact>.');
  }

  if (parsed.from) {
    const metadata = await readCliMetadata(parsed.from);
    const request = resolveGenerateRequestFromArtifact(parsed, metadata, globalFlags);
    if (parsed.dryRun) {
      const command = buildGenerateCliCommand(
        {
          serverRef: request.serverRef,
          configPath: request.configPath,
          rootDir: request.rootDir,
          outputPath: request.outputPath,
          bundle: request.bundle,
          compile: request.compile,
          runtime: request.runtime ?? 'node',
          timeoutMs: request.timeoutMs ?? 30_000,
          minify: request.minify ?? false,
          includeTools: request.includeTools,
          excludeTools: request.excludeTools,
        },
        metadata.server.definition,
        globalFlags
      );
      console.log('Dry run — would execute:');
      console.log(`  ${command}`);
      return;
    }
    await performGenerateFromArtifact(metadata, request);
    return;
  }

  const inferredName = parsed.name ?? (parsed.command ? inferNameFromCommand(parsed.command) : undefined);
  const serverRef =
    parsed.server ??
    (parsed.command && inferredName
      ? JSON.stringify(buildInlineServerDefinition(inferredName, parsed.command, parsed.description))
      : undefined);
  if (!serverRef) {
    throw new Error(
      'Provide --server with a definition or a command we can infer a name from (use --name to override).'
    );
  }
  await performGenerateFromRequest({
    serverRef,
    configPath: globalFlags['--config'],
    rootDir: globalFlags['--root'],
    outputPath: parsed.output,
    runtime: parsed.runtime,
    bundler: parsed.bundler,
    bundle: parsed.bundle,
    timeoutMs: parsed.timeout,
    compile: parsed.compile,
    minify: parsed.minify ?? false,
    includeTools: parsed.includeTools,
    excludeTools: parsed.excludeTools,
  });
}

export function printGenerateCliHelp(): void {
  console.error(
    [
      'Usage: mcporter generate-cli [server | command | url] [flags]',
      '',
      'Targets:',
      '  <server>                Use a configured server.',
      '  <command|url>           Infer an inline stdio or HTTP server.',
      '  --server <name|json>    Server name, HTTP URL, or JSON definition.',
      '  --command <value>       Inline stdio command or HTTP URL.',
      '  --from <artifact>       Regenerate from an existing generated CLI.',
      '',
      'Flags:',
      '  --output <path>         Write the TypeScript template to a path.',
      '  --bundle [path]         Emit a bundled JavaScript artifact.',
      '  --compile [path]        Emit a Bun-compiled binary.',
      '  --runtime node|bun      Runtime for generated code.',
      '  --bundler rolldown|bun  Bundler for JavaScript output.',
      '  --timeout <ms>          Discovery/call timeout in milliseconds.',
      '  --minify / --no-minify  Toggle bundle minification.',
      '  --include-tools a,b     Generate only these tools.',
      '  --exclude-tools a,b     Omit these tools.',
      '  --dry-run               Print regeneration command for --from.',
    ].join('\n')
  );
}
