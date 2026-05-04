import { wrapCallResult } from '../result-utils.js';
import { consumeOutputFormat } from './output-format.js';
import { printCallOutput } from './output-utils.js';

type Runtime = Awaited<ReturnType<(typeof import('../runtime.js'))['createRuntime']>>;

export async function handleResource(runtime: Runtime, args: string[]): Promise<void> {
  const output = consumeOutputFormat(args, {
    defaultFormat: 'auto',
    allowed: ['auto', 'text', 'markdown', 'json', 'raw'],
    enableRawShortcut: true,
    jsonShortcutFlag: '--json',
  });
  const server = args.shift();
  if (!server) {
    throw new Error('Missing server name. Usage: mcporter resource <server> [uri]');
  }
  const uri = args.shift();
  if (args.length > 0) {
    throw new Error(`Unexpected resource arguments: ${args.join(' ')}`);
  }

  const result = uri ? await runtime.readResource(server, uri) : await runtime.listResources(server);
  const { callResult } = wrapCallResult(result);
  printCallOutput(callResult, result, output);
}

export function printResourceHelp(): void {
  console.error(
    [
      'Usage: mcporter resource <server> [uri] [flags]',
      '',
      'Without a URI, lists resources exposed by the server.',
      'With a URI, reads that MCP resource and prints text/markdown/json content when possible.',
      '',
      'Flags:',
      '  --output auto|text|markdown|json|raw  Choose output rendering.',
      '  --json                               Shortcut for --output json.',
      '  --raw                                Shortcut for --output raw.',
      '',
      'Examples:',
      '  mcporter resource docs',
      '  mcporter resource docs file:///repo/README.md',
      '  mcporter resource docs greeting://Peter --output text',
    ].join('\n')
  );
}
