import readline from 'node:readline';
import type {
  Client,
  ElicitRequest,
  ElicitRequestFormParams,
  ElicitRequestURLParams,
  ElicitResult,
} from '@modelcontextprotocol/client';

export interface ElicitationContext {
  readonly server: string;
}

export type ElicitationHandler = (
  request: ElicitRequest,
  context: ElicitationContext
) => ElicitResult | Promise<ElicitResult>;

export interface ElicitationResponder {
  readonly handler: ElicitationHandler;
  didDecline(): boolean;
}

export interface InteractiveElicitationOptions {
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
}

export interface NonInteractiveElicitationOptions {
  readonly onDecline?: (request: ElicitRequest, context: ElicitationContext) => void;
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
    handler: async (request, context) => {
      const result = await handleInteractiveRequest(request.params, context, input, output);
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
    handler: async (request, context) => {
      declined = true;
      options.onDecline?.(request, context);
      return { action: 'decline' };
    },
    didDecline: () => declined,
  };
}

export function registerElicitationHandler(
  client: Client,
  handler: ElicitationHandler,
  context: ElicitationContext
): void {
  client.setRequestHandler('elicitation/create', async (request) => handler(request, context));
}

async function handleInteractiveRequest(
  params: ElicitRequest['params'],
  context: ElicitationContext,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream
): Promise<ElicitResult> {
  const rl = readline.createInterface({ input, output, terminal: true });
  try {
    writeLine(output, `\nServer '${sanitizeTerminalText(context.server)}' is requesting input:`);
    writeLine(output, sanitizeTerminalText(params.message));
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
  writeLine(output, `\nOpen this URL to continue:\n${sanitizeTerminalText(params.url)}\n`);
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
  const label = sanitizeTerminalText(schema.title ?? name);
  if (schema.description) writeLine(output, sanitizeTerminalText(schema.description));
  const choices = enumChoices(schema);
  const displayChoices = choices.map(sanitizeTerminalText);
  if (displayChoices.length > 0) writeLine(output, `  Choices: ${displayChoices.join(', ')}`);
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
  const displayChoices = choices.map(sanitizeTerminalText);
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
      ? { ok: false, message: `Choose comma-separated values from: ${displayChoices.join(', ')}.` }
      : { ok: true, value: values };
  }
  if (choices.length > 0 && !choices.includes(answer)) {
    return { ok: false, message: `Choose one of: ${displayChoices.join(', ')}.` };
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
  return sanitizeTerminalText(Array.isArray(value) ? value.join(', ') : String(value));
}

export function sanitizeTerminalText(value: string): string {
  const withoutEscapes = stripAnsiSequences(value);
  let withoutControls = '';
  for (const character of withoutEscapes) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (character === '\r' || character === '\n' || character === '\t') {
      withoutControls += ' ';
    } else if (codePoint > 0x1f && (codePoint < 0x7f || codePoint > 0x9f)) {
      withoutControls += character;
    }
  }
  return collapseSpaces(withoutControls).trim();
}

function stripAnsiSequences(value: string): string {
  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x9b) {
      index = consumeControlSequence(value, index + 1);
      continue;
    }
    if (code !== 0x1b) {
      output += value[index];
      continue;
    }

    const introducer = value.charAt(index + 1);
    if (introducer === '[') {
      index = consumeControlSequence(value, index + 2);
    } else if (introducer === ']' || introducer === 'P' || introducer === '^' || introducer === '_') {
      index = consumeStringSequence(value, index + 2, introducer === ']');
    } else if (introducer) {
      index += 1;
    }
  }
  return output;
}

function consumeControlSequence(value: string, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) {
      return index;
    }
  }
  return value.length;
}

function consumeStringSequence(value: string, start: number, allowBell: boolean): number {
  for (let index = start; index < value.length; index += 1) {
    if (allowBell && value.charCodeAt(index) === 0x07) {
      return index;
    }
    if (value.charCodeAt(index) === 0x1b && value.charAt(index + 1) === '\\') {
      return index + 1;
    }
  }
  return value.length;
}

function collapseSpaces(value: string): string {
  let output = '';
  let previousWasSpace = false;
  for (const character of value) {
    if (character === ' ') {
      if (!previousWasSpace) {
        output += character;
      }
      previousWasSpace = true;
    } else {
      output += character;
      previousWasSpace = false;
    }
  }
  return output;
}

function writeLine(output: NodeJS.WritableStream, message: string): void {
  output.write(`${message}\n`);
}
