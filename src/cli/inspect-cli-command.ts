import { readCliMetadata } from '../cli-metadata.js';
import { expectValue } from './flag-utils.js';
import { buildGenerateCliCommand, shellQuote } from './generate/template-data.js';
import { formatSourceSuffix } from './list-format.js';
import { consumeOutputFormat } from './output-format.js';
import { formatPathForDisplay } from './path-utils.js';
import { CliUsageError } from './errors.js';

interface InspectFlags {
  artifactPath: string;
  format: 'text' | 'json';
}

export async function handleInspectCli(args: string[]): Promise<void> {
  const parsed = parseInspectFlags(args);
  const metadata = await readCliMetadata(parsed.artifactPath);
  if (parsed.format === 'json') {
    console.log(JSON.stringify(metadata, null, 2));
    return;
  }
  console.log(`Artifact: ${formatPathForDisplay(metadata.artifact.path)} (${metadata.artifact.kind})`);
  console.log(`Server: ${metadata.server.name}`);
  if (metadata.server.source) {
    const suffix = formatSourceSuffix(metadata.server.source, true);
    if (suffix) {
      console.log(`Source: ${suffix}`);
    }
  }
  console.log(
    `Generated: ${new Date(metadata.generatedAt).toISOString()} via ${metadata.generator.name}@${
      metadata.generator.version
    }`
  );
  if (metadata.invocation.runtime) {
    console.log(`Runtime: ${metadata.invocation.runtime}`);
  }
  console.log('Invocation flags:');
  for (const [key, value] of Object.entries(metadata.invocation)) {
    if (value === undefined || value === null || key === 'runtime') {
      continue;
    }
    console.log(`  ${key}: ${Array.isArray(value) ? JSON.stringify(value) : String(value)}`);
  }
  const dryRunCommand = buildGenerateCliCommand(metadata.invocation, metadata.server.definition);
  console.log('Regenerate with:');
  console.log(`  mcporter generate-cli --from ${shellQuote(parsed.artifactPath)}`);
  if (dryRunCommand) {
    console.log('Underlying generate-cli command:');
    console.log(`  ${dryRunCommand}`);
  }
}

export function printInspectCliHelp(): void {
  console.error(
    [
      'Usage: mcporter inspect-cli <artifact> [flags]',
      '',
      'Flags:',
      '  --json                  Print embedded metadata as JSON.',
      '  --format text|json      Choose output format.',
    ].join('\n')
  );
}

function parseInspectFlags(args: string[]): InspectFlags {
  let format = consumeOutputFormat(args, {
    defaultFormat: 'text',
    allowed: ['text', 'json'],
    enableRawShortcut: false,
    jsonShortcutFlag: '--json',
  }) as InspectFlags['format'];
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (!token) {
      index += 1;
      continue;
    }
    if (token === '--format') {
      const value = expectValue(token, args[index + 1]);
      if (value !== 'json' && value !== 'text') {
        throw new CliUsageError("--format must be 'json' or 'text'.");
      }
      format = value;
      args.splice(index, 2);
      continue;
    }
    if (token.startsWith('--')) {
      throw new CliUsageError(`Unknown flag '${token}' for inspect-cli.`);
    }
    index += 1;
  }
  const artifactPath = args.shift();
  if (!artifactPath) {
    throw new CliUsageError('Usage: mcporter inspect-cli <artifact> [--json]');
  }
  if (args.length > 0) {
    throw new CliUsageError(`Unexpected inspect-cli argument '${args[0]}'.`);
  }
  return { artifactPath, format };
}

export const __test = {
  parseInspectFlags,
};
