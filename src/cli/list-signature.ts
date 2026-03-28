import type { GeneratedOption } from './generate/tools.js';
import { buildFallbackLiteral, pickExampleLiteral } from './generate/tools.js';
import { cyanText, dimText, extraDimText } from './terminal.js';

export interface SignatureFormatOptions {
  colorize?: boolean;
  defaultReturnType?: string;
}

export interface FlagUsageExtra {
  text: string;
  required?: boolean;
}

export function formatFunctionSignature(
  name: string,
  options: GeneratedOption[],
  outputSchema: unknown,
  formatOptions?: SignatureFormatOptions
): string {
  const colorize = formatOptions?.colorize !== false;
  const keyword = colorize ? extraDimText('function') : 'function';
  const formattedName = colorize ? cyanText(name) : name;
  const paramsText = options.map((option) => formatInlineParameter(option, colorize)).join(', ');
  const returnType = inferReturnTypeName(outputSchema) ?? formatOptions?.defaultReturnType;
  const signature = `${keyword} ${formattedName}(${paramsText})`;
  return returnType ? `${signature}: ${returnType};` : `${signature};`;
}

export function formatOptionalSummary(hiddenOptions: GeneratedOption[], options?: { colorize?: boolean }): string {
  const colorize = options?.colorize !== false;
  const maxNames = 5;
  const names = hiddenOptions.map((option) => option.property);
  if (names.length === 0) {
    return '';
  }
  const preview = names.slice(0, maxNames).join(', ');
  const suffix = names.length > maxNames ? ', ...' : '';
  const tint = colorize ? extraDimText : (value: string): string => value;
  return tint(`// optional (${names.length}): ${preview}${suffix}`);
}

export function formatFlagUsage(
  options: GeneratedOption[],
  extras?: FlagUsageExtra[],
  opts?: { colorize?: boolean }
): string {
  const colorize = opts?.colorize !== false;
  const entries: Array<{ text: string; required: boolean }> = options.map((option) => ({
    text: formatFlagLabel(option),
    required: option.required,
  }));
  if (extras) {
    entries.push(
      ...extras
        .map((extra) => ({
          text: extra.text.trim(),
          required: Boolean(extra.required),
        }))
        .filter((entry) => entry.text.length > 0)
    );
  }
  const parts = entries
    .filter((entry) => entry.text.length > 0)
    .map((entry) => (entry.required ? entry.text : `[${entry.text}]`));
  if (parts.length === 0) {
    return '';
  }
  const rendered = parts.join(' ');
  return colorize ? extraDimText(rendered) : rendered;
}

export function formatFlagLabel(option: GeneratedOption): string {
  return `--${option.cliName} ${option.placeholder}`.trim();
}

export function formatCallExpressionExample(
  serverName: string,
  toolName: string,
  options: GeneratedOption[],
  extra?: { callSelector?: string; wrapExpression?: boolean }
): string | undefined {
  const assignments = options
    .map((option) => ({ option, literal: pickExampleLiteral(option) }))
    .filter(({ option, literal }) => option.required || literal !== undefined)
    .map(({ option, literal }) => {
      const value = literal ?? buildFallbackLiteral(option);
      return `${option.property}: ${value}`;
    });

  const args = assignments.join(', ');
  const callSuffix = assignments.length > 0 ? `(${args})` : '()';
  const selector = extra?.callSelector ?? serverName;
  const expression = `${selector}.${toolName}${callSuffix}`;
  const rendered = extra?.wrapExpression ? quoteShellExpression(expression) : expression;
  return `mcporter call ${rendered}`;
}

export function formatExampleBlock(
  examples: string[],
  options?: { maxExamples?: number; maxLength?: number }
): string[] {
  const maxExamples = options?.maxExamples ?? 1;
  const maxLength = options?.maxLength ?? 80;
  return Array.from(new Set(examples))
    .filter(Boolean)
    .slice(0, maxExamples)
    .map((example) => truncateExample(example, maxLength));
}

function truncateExample(example: string, maxLength: number): string {
  if (example.length <= maxLength) {
    return example;
  }
  const openIndex = example.indexOf('(');
  const closeIndex = example.lastIndexOf(')');
  if (openIndex === -1 || closeIndex === -1 || closeIndex <= openIndex) {
    return `${example.slice(0, Math.max(0, maxLength - 1))}…`;
  }
  const prefix = example.slice(0, openIndex + 1);
  const suffix = example.slice(closeIndex);
  const available = maxLength - prefix.length - suffix.length - 5;
  if (available <= 0) {
    return `${prefix}...${suffix}`;
  }
  const args = example.slice(openIndex + 1, closeIndex).trim();
  const shortened = args
    .slice(0, available)
    .trimEnd()
    .replace(/[\s,]+$/, '');
  const ellipsis = shortened.length > 0 ? `${shortened}, ...` : '...';
  return `${prefix}${ellipsis}${suffix}`;
}

function formatInlineParameter(option: GeneratedOption, colorize: boolean): string {
  const typeAnnotation = formatTypeAnnotation(option, colorize);
  const optionalSuffix = option.required ? '' : '?';
  return `${option.property}${optionalSuffix}: ${typeAnnotation}`;
}

function quoteShellExpression(expression: string): string {
  if (!expression.includes("'")) {
    return `'${expression}'`;
  }
  const escaped = expression.replace(/(["\\$`])/g, '\\$1');
  return `"${escaped}"`;
}

function inferReturnTypeName(schema: unknown): string | undefined {
  if (!schema || typeof schema !== 'object') {
    return undefined;
  }
  return inferSchemaDisplayType(schema as Record<string, unknown>);
}

function inferSchemaDisplayType(descriptor: Record<string, unknown>): string {
  const title = typeof descriptor.title === 'string' ? descriptor.title.trim() : undefined;
  if (title) {
    return title;
  }
  const type = typeof descriptor.type === 'string' ? (descriptor.type as string) : undefined;
  if (!type && typeof descriptor.properties === 'object') {
    return 'object';
  }
  if (!type && descriptor.items && typeof descriptor.items === 'object') {
    return `${inferSchemaDisplayType(descriptor.items as Record<string, unknown>)}[]`;
  }
  if (type === 'array' && descriptor.items && typeof descriptor.items === 'object') {
    return `${inferSchemaDisplayType(descriptor.items as Record<string, unknown>)}[]`;
  }
  if (!type && Array.isArray(descriptor.enum)) {
    const values = (descriptor.enum as unknown[]).filter((entry): entry is string => typeof entry === 'string');
    if (values.length > 0) {
      return values.map((entry) => JSON.stringify(entry)).join(' | ');
    }
  }
  return type ?? 'unknown';
}

function formatTypeAnnotation(option: GeneratedOption, colorize: boolean): string {
  let baseType: string;
  if (option.enumValues && option.enumValues.length > 0) {
    baseType = option.enumValues.map((value) => JSON.stringify(value)).join(' | ');
  } else {
    switch (option.type) {
      case 'number':
        baseType = 'number';
        break;
      case 'boolean':
        baseType = 'boolean';
        break;
      case 'array':
        baseType = 'string[]';
        break;
      case 'object':
        baseType = 'Record<string, unknown>';
        break;
      case 'string':
        baseType = 'string';
        break;
      default:
        baseType = 'unknown';
        break;
    }
  }
  const tint = colorize ? dimText : (value: string): string => value;
  const base = tint(baseType);
  if (option.formatHint && option.type === 'string' && (!option.enumValues || option.enumValues.length === 0)) {
    const descriptionText = option.description?.toLowerCase() ?? '';
    const hintLower = option.formatHint.toLowerCase();
    const normalizedDescription = descriptionText.replace(/[\s_-]+/g, '');
    const normalizedHint = hintLower.replace(/[\s_-]+/g, '');
    const hasHintInDescription = descriptionText.includes(hintLower) || normalizedDescription.includes(normalizedHint);
    if (hasHintInDescription) {
      return base;
    }
    return `${base} ${tint(`/* ${option.formatHint} */`)}`;
  }
  return base;
}
