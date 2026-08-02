import readline from 'node:readline';
import type {
  Client,
  ElicitRequest,
  ElicitRequestFormParams,
  ElicitRequestURLParams,
  ElicitResult,
} from '@modelcontextprotocol/client';

export type ElicitationHandler = (request: ElicitRequest) => ElicitResult | Promise<ElicitResult>;

export interface ElicitationResponder {
  readonly handler: ElicitationHandler;
  didDecline(): boolean;
}

interface InteractiveElicitationOptions {
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
}

interface NonInteractiveElicitationOptions {
  readonly onDecline?: (request: ElicitRequest) => void;
}

type PrimitiveValue = string | number | boolean | string[];
type PrimitiveSchema = ElicitRequestFormParams['requestedSchema']['properties'][string];

export const NON_INTERACTIVE_ELICITATION_HINT = 'Server requested interactive input; run mcporter in a terminal.';

export function createInteractiveElicitationResponder(
  options: InteractiveElicitationOptions = {}
): ElicitationResponder {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stderr;
  let declined = false;

  return {
    handler: async (request) => {
      const result = await handleInteractiveRequest(request.params, input, output);
      if (result.action !== 'accept') declined = true;
      return result;
    },
    didDecline: () => declined,
  };
}

export function createNonInteractiveElicitationResponder(
  options: NonInteractiveElicitationOptions = {}
): ElicitationResponder {
  let declined = false;
  return {
    handler: async (request) => {
      declined = true;
      options.onDecline?.(request);
      return { action: 'decline' };
    },
    didDecline: () => declined,
  };
}

export function registerElicitationHandler(client: Client, handler: ElicitationHandler): void {
  client.setRequestHandler('elicitation/create', async (request) => handler(request));
}

async function handleInteractiveRequest(
  params: ElicitRequest['params'],
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream
): Promise<ElicitResult> {
  const rl = readline.createInterface({ input, output, terminal: true });
  try {
    writeLine(output, `\n${params.message}`);
    if (params.mode === 'url') return await handleUrlRequest(rl, params, output);
    return await handleFormRequest(rl, params, output);
  } finally {
    rl.close();
  }
}

async function handleUrlRequest(
  rl: readline.Interface,
  params: ElicitRequestURLParams,
  output: NodeJS.WritableStream
): Promise<ElicitResult> {
  writeLine(output, `\nOpen this URL to continue:\n${params.url}\n`);
  const answer = await ask(rl, 'Press Enter when you are done (Ctrl-C to decline): ');
  return answer === undefined ? { action: 'decline' } : { action: 'accept' };
}

async function handleFormRequest(
  rl: readline.Interface,
  params: ElicitRequestFormParams,
  output: NodeJS.WritableStream
): Promise<ElicitResult> {
  const required = new Set(params.requestedSchema.required ?? []);
  const content: Record<string, PrimitiveValue> = {};
  for (const [name, schema] of Object.entries(params.requestedSchema.properties)) {
    const value = await promptForField(rl, output, name, schema, required.has(name));
    if (value.kind === 'decline') return { action: 'decline' };
    if (value.value !== undefined) content[name] = value.value;
  }
  return { action: 'accept', content };
}

async function promptForField(
  rl: readline.Interface,
  output: NodeJS.WritableStream,
  name: string,
  schema: PrimitiveSchema,
  required: boolean
): Promise<{ kind: 'answer'; value?: PrimitiveValue } | { kind: 'decline' }> {
  const label = schema.title ?? name;
  if (schema.description) writeLine(output, schema.description);
  const choices = enumChoices(schema);
  if (choices.length > 0) writeLine(output, `  Choices: ${choices.join(', ')}`);
  const defaultValue = 'default' in schema ? schema.default : undefined;
  const suffix = `${required ? ' (required)' : ''}${defaultValue !== undefined ? ` [${formatDefault(defaultValue)}]` : ''}: `;

  while (true) {
    const answer = await ask(rl, `${label}${suffix}`);
    if (answer === undefined) return { kind: 'decline' };
    const trimmed = answer.trim();
    if (trimmed.length === 0) {
      if (defaultValue !== undefined) return { kind: 'answer', value: defaultValue };
      if (!required) return { kind: 'answer' };
      writeLine(output, `${label} is required.`);
      continue;
    }

    const parsed = parsePrimitive(trimmed, schema, choices);
    if (parsed.ok) return { kind: 'answer', value: parsed.value };
    writeLine(output, parsed.message);
  }
}

function parsePrimitive(
  answer: string,
  schema: PrimitiveSchema,
  choices: readonly string[]
): { ok: true; value: PrimitiveValue } | { ok: false; message: string } {
  if (schema.type === 'boolean') {
    const normalized = answer.toLowerCase();
    if (['true', 'yes', 'y', '1'].includes(normalized)) return { ok: true, value: true };
    if (['false', 'no', 'n', '0'].includes(normalized)) return { ok: true, value: false };
    return { ok: false, message: 'Enter yes/no or true/false.' };
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    const value = Number(answer);
    if (!Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) {
      return { ok: false, message: `Enter a valid ${schema.type}.` };
    }
    if (schema.minimum !== undefined && value < schema.minimum) {
      return { ok: false, message: `Enter a value greater than or equal to ${schema.minimum}.` };
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      return { ok: false, message: `Enter a value less than or equal to ${schema.maximum}.` };
    }
    return { ok: true, value };
  }
  if (schema.type === 'array') {
    const values = answer
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    const invalid = values.find((value) => !choices.includes(value));
    return invalid
      ? { ok: false, message: `Choose comma-separated values from: ${choices.join(', ')}.` }
      : { ok: true, value: values };
  }
  if (choices.length > 0 && !choices.includes(answer)) {
    return { ok: false, message: `Choose one of: ${choices.join(', ')}.` };
  }
  if ('minLength' in schema && schema.minLength !== undefined && answer.length < schema.minLength) {
    return { ok: false, message: `Enter at least ${schema.minLength} characters.` };
  }
  if ('maxLength' in schema && schema.maxLength !== undefined && answer.length > schema.maxLength) {
    return { ok: false, message: `Enter no more than ${schema.maxLength} characters.` };
  }
  return { ok: true, value: answer };
}

function enumChoices(schema: PrimitiveSchema): string[] {
  if ('enum' in schema && Array.isArray(schema.enum)) return [...schema.enum];
  if ('oneOf' in schema && Array.isArray(schema.oneOf)) return schema.oneOf.map((entry) => entry.const);
  if (schema.type === 'array') {
    if ('enum' in schema.items && Array.isArray(schema.items.enum)) return [...schema.items.enum];
    if ('anyOf' in schema.items && Array.isArray(schema.items.anyOf)) {
      return schema.items.anyOf.map((entry) => entry.const);
    }
  }
  return [];
}

function ask(rl: readline.Interface, prompt: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      rl.off('SIGINT', onInterrupt);
      rl.off('close', onClose);
      resolve(value);
    };
    const onInterrupt = () => finish(undefined);
    const onClose = () => finish(undefined);
    rl.once('SIGINT', onInterrupt);
    rl.once('close', onClose);
    rl.question(prompt, (answer) => finish(answer));
  });
}

function formatDefault(value: PrimitiveValue): string {
  return Array.isArray(value) ? value.join(', ') : String(value);
}

function writeLine(output: NodeJS.WritableStream, message: string): void {
  output.write(`${message}\n`);
}
