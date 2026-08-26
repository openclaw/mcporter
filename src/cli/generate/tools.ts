import type { ServerToolInfo } from '../../runtime.js';

export interface ToolMetadata {
  tool: ServerToolInfo;
  methodName: string;
  options: GeneratedOption[];
}

export interface GeneratedOption {
  property: string;
  cliName: string;
  description?: string;
  required: boolean;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'unknown';
  arrayItemType?: 'string' | 'number' | 'boolean' | 'object' | 'unknown';
  placeholder: string;
  exampleValue?: string;
  enumValues?: string[];
  defaultValue?: unknown;
  formatHint?: string;
}

function resolveSchemaType(value: unknown): GeneratedOption['type'] | undefined {
  if (value === 'integer') {
    return 'number';
  }
  if (value === 'string' || value === 'number' || value === 'boolean' || value === 'array' || value === 'object') {
    return value;
  }
  return undefined;
}

function resolveArrayItemType(value: unknown): GeneratedOption['arrayItemType'] | undefined {
  if (value === 'integer') {
    return 'number';
  }
  if (value === 'string' || value === 'number' || value === 'boolean' || value === 'object') {
    return value;
  }
  return undefined;
}

export function buildToolMetadata(tool: ServerToolInfo): ToolMetadata {
  const methodName = toProxyMethodName(tool.name);
  const properties = extractOptions(tool);
  return {
    tool,
    methodName,
    options: properties,
  };
}

export function buildToolMetadataList(
  tools: ServerToolInfo[],
  options: { readonly sort?: boolean; readonly onCollision?: 'throw' | 'skip' } = {}
): ToolMetadata[] {
  const result = tools.map((tool) => buildToolMetadata(tool));
  if (options.sort !== false) {
    result.sort((left, right) => left.tool.name.localeCompare(right.tool.name));
  }
  const methods = new Map<string, string>();
  const kept: ToolMetadata[] = [];
  for (const entry of result) {
    const previous = methods.get(entry.methodName);
    if (previous !== undefined) {
      // Servers in the wild re-advertise the same tool name; that is not a real
      // conflict, so drop the repeat regardless of collision policy. Distinct
      // names mapping to one method is ambiguous and still fails codegen.
      if (previous === entry.tool.name) continue;
      if (options.onCollision !== 'skip') {
        throw new Error(
          `Generated proxy method collision '${entry.methodName}' for tools '${previous}' and '${entry.tool.name}'.`
        );
      }
      continue;
    }
    methods.set(entry.methodName, entry.tool.name);
    kept.push(entry);
  }
  return kept;
}

export function buildEmbeddedSchemaMap(tools: ToolMetadata[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const entry of tools.toSorted((left, right) => left.tool.name.localeCompare(right.tool.name))) {
    if (entry.tool.inputSchema && typeof entry.tool.inputSchema === 'object') {
      result[entry.tool.name] = entry.tool.inputSchema;
    }
  }
  return result;
}

export function extractOptions(tool: ServerToolInfo): GeneratedOption[] {
  const schema = tool.inputSchema;
  if (!schema || typeof schema !== 'object') {
    return [];
  }
  const record = schema as Record<string, unknown>;
  if (record.type !== 'object' || typeof record.properties !== 'object') {
    return [];
  }
  // Flatten schema properties into Commander-friendly option descriptors.
  const properties = record.properties as Record<string, unknown>;
  const requiredList = Array.isArray(record.required) ? (record.required as string[]) : [];
  const entries = Object.entries(properties);
  const cliNames = assignCliNames(entries.map(([property]) => property));
  return entries.map(([property, descriptor], index) => {
    const cliName = cliNames[index] as string;
    const type = inferType(descriptor);
    const arrayItemType = type === 'array' ? inferArrayItemType(descriptor) : undefined;
    const enumValues = getEnumValues(descriptor);
    const defaultValue = getDescriptorDefault(descriptor);
    const formatInfo = getDescriptorFormatHint(descriptor);
    const placeholder = buildPlaceholder(cliName, type, enumValues, formatInfo?.slug);
    const exampleValue = buildExampleValue(property, type, enumValues, defaultValue, arrayItemType);
    return {
      property,
      cliName,
      description: getDescriptorDescription(descriptor),
      required: requiredList.includes(property),
      type,
      arrayItemType,
      placeholder,
      exampleValue,
      enumValues,
      defaultValue,
      formatHint: formatInfo?.display,
    };
  });
}

const EMPTY_CLI_OPTION_STEM = 'option';

// Two legal property spellings can normalize onto one flag - `Query` beside `query`, or
// `no_cache` beside `noCache` - and commander would then declare that flag twice and read one
// value into both arguments. Schema order keeps the plain flag; a later property takes the first
// suffix no other property claims.
function assignCliNames(properties: string[]): string[] {
  const natural = properties.map((property) => toCliOption(property));
  const claimed = new Set(natural);
  const used = new Set<string>();
  return natural.map((base) => {
    let name = base;
    let suffix = 2;
    while (used.has(name) || (name !== base && claimed.has(name))) {
      name = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(name);
    return name;
  });
}

export function getEnumValues(descriptor: unknown): string[] | undefined {
  if (!descriptor || typeof descriptor !== 'object') {
    return undefined;
  }
  const record = descriptor as Record<string, unknown>;
  if (Array.isArray(record.enum)) {
    const values = record.enum.filter((entry): entry is string => typeof entry === 'string');
    return values.length > 0 ? values : undefined;
  }
  if (isArraySchema(record) && typeof record.items === 'object' && record.items !== null) {
    const nested = record.items as Record<string, unknown>;
    if (Array.isArray(nested.enum)) {
      const values = nested.enum.filter((entry): entry is string => typeof entry === 'string');
      return values.length > 0 ? values : undefined;
    }
  }
  return undefined;
}

export function getDescriptorDefault(descriptor: unknown): unknown {
  if (!descriptor || typeof descriptor !== 'object') {
    return undefined;
  }
  const record = descriptor as Record<string, unknown>;
  if (record.default !== undefined) {
    return record.default;
  }
  if (record.type === 'array' && typeof record.items === 'object' && record.items !== null) {
    return Array.isArray(record.default) ? record.default : undefined;
  }
  return undefined;
}

export function buildPlaceholder(
  property: string,
  type: GeneratedOption['type'],
  enumValues?: string[],
  formatSlug?: string
): string {
  const normalized = toCliOption(property);
  if (enumValues && enumValues.length > 0) {
    // Enum members can describe an array's items, and the generated parser splits those
    // flags on commas, so keep the multi-value hint next to the choices.
    const suffix = type === 'array' ? ',...' : '';
    return `<${normalized}:${enumValues.join('|')}${suffix}>`;
  }
  switch (type) {
    case 'number':
      return `<${normalized}:number>`;
    case 'boolean':
      return `<${normalized}:true|false>`;
    case 'array':
      return `<${normalized}:value1,value2>`;
    case 'object':
      return `<${normalized}:json>`;
    default:
      if (formatSlug) {
        return `<${normalized}:${formatSlug}>`;
      }
      return `<${normalized ?? 'value'}>`;
  }
}

export function buildExampleValue(
  property: string,
  type: GeneratedOption['type'],
  enumValues: string[] | undefined,
  defaultValue: unknown,
  arrayItemType?: GeneratedOption['arrayItemType']
): string | undefined {
  if (enumValues && enumValues.length > 0) {
    return enumValues[0] as string;
  }
  if (defaultValue !== undefined) {
    try {
      return typeof defaultValue === 'string' ? defaultValue : JSON.stringify(defaultValue);
    } catch {
      return undefined;
    }
  }
  switch (type) {
    case 'number':
      return '1';
    case 'boolean':
      return 'true';
    case 'array':
      switch (arrayItemType) {
        case 'number':
          return '1,2';
        case 'boolean':
          return 'true,false';
        case 'object':
          return '[{"key":"value"}]';
        default:
          return 'value1,value2';
      }
    case 'object':
      return '{"key":"value"}';
    default:
      if (property.toLowerCase().includes('path')) {
        return '/path/to/file.md';
      }
      if (property.toLowerCase().includes('id')) {
        return 'example-id';
      }
      return undefined;
  }
}

export function pickExampleLiteral(option: GeneratedOption): string | undefined {
  if (option.type === 'array') {
    if (Array.isArray(option.defaultValue)) {
      try {
        return JSON.stringify(option.defaultValue);
      } catch {
        return undefined;
      }
    }
    if (option.enumValues && option.enumValues.length > 0) {
      return JSON.stringify([option.enumValues[0]]);
    }
    switch (option.arrayItemType) {
      case 'number':
        return '[1, 2]';
      case 'boolean':
        return '[true, false]';
      case 'object':
        return '[{"key":"value"}]';
      default:
        break;
    }
  }
  if (option.enumValues && option.enumValues.length > 0) {
    return JSON.stringify(option.enumValues[0]);
  }
  if (!option.exampleValue) {
    return undefined;
  }
  if (option.type === 'array') {
    const values = option.exampleValue
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (values.length === 0) {
      return undefined;
    }
    return `[${values.map((entry) => JSON.stringify(entry)).join(', ')}]`;
  }
  if (option.type === 'number' || option.type === 'boolean' || option.type === 'object') {
    return option.exampleValue;
  }
  try {
    const parsed = JSON.parse(option.exampleValue);
    if (typeof parsed === 'number' || typeof parsed === 'boolean') {
      return option.exampleValue;
    }
  } catch {
    // fall through to quoted string literal
  }
  return JSON.stringify(option.exampleValue);
}

export function buildFallbackLiteral(option: GeneratedOption): string {
  switch (option.type) {
    case 'number':
      return '1';
    case 'boolean':
      return 'true';
    case 'array':
      switch (option.arrayItemType) {
        case 'number':
          return '[1]';
        case 'boolean':
          return '[true]';
        case 'object':
          return '[{"key":"value"}]';
        default:
          return '["value1"]';
      }
    case 'object':
      return '{"key":"value"}';
    default: {
      if (option.property.toLowerCase().includes('id')) {
        return JSON.stringify('example-id');
      }
      if (option.property.toLowerCase().includes('url')) {
        return JSON.stringify('https://example.com');
      }
      return JSON.stringify('value');
    }
  }
}

export function inferType(descriptor: unknown): GeneratedOption['type'] {
  if (!descriptor || typeof descriptor !== 'object') {
    return 'unknown';
  }
  const type = (descriptor as Record<string, unknown>).type;
  if (Array.isArray(type)) {
    for (const entry of type) {
      const resolved = resolveSchemaType(entry);
      if (resolved) {
        return resolved;
      }
    }
    return 'unknown';
  }
  const resolved = resolveSchemaType(type);
  if (resolved) {
    return resolved;
  }
  return 'unknown';
}

// `type` may be a union such as `["array", "null"]`, so ask inferType instead of comparing the
// raw value: these container checks have to agree with the type the option is generated with.
function isArraySchema(record: Record<string, unknown>): boolean {
  return inferType(record) === 'array';
}

export function inferArrayItemType(descriptor: unknown): GeneratedOption['arrayItemType'] {
  if (!descriptor || typeof descriptor !== 'object') {
    return 'unknown';
  }
  const record = descriptor as Record<string, unknown>;
  if (!isArraySchema(record) || !record.items || typeof record.items !== 'object') {
    return 'unknown';
  }
  const items = record.items as Record<string, unknown>;
  const itemType = items.type;
  if (Array.isArray(itemType)) {
    for (const entry of itemType) {
      const resolved = resolveArrayItemType(entry);
      if (resolved) {
        return resolved;
      }
    }
    return 'unknown';
  }
  const resolved = resolveArrayItemType(itemType);
  if (resolved) {
    return resolved;
  }
  return 'unknown';
}

export function getDescriptorDescription(descriptor: unknown): string | undefined {
  if (typeof descriptor !== 'object' || descriptor === null) {
    return undefined;
  }
  const record = descriptor as Record<string, unknown>;
  return typeof record.description === 'string' ? (record.description as string) : undefined;
}

export function getDescriptorFormatHint(descriptor: unknown): { display: string; slug: string } | undefined {
  if (typeof descriptor !== 'object' || descriptor === null) {
    return undefined;
  }
  const record = descriptor as Record<string, unknown>;
  const formatRaw = typeof record.format === 'string' ? record.format : undefined;
  const description = typeof record.description === 'string' ? record.description : undefined;

  const iso8601FromDescription =
    !formatRaw && description && /\biso[-\s]*8601\b/i.test(description) ? 'iso-8601' : undefined;
  const isoFormatFromDescription =
    !formatRaw && !iso8601FromDescription && description && /\biso\s+format\b/i.test(description)
      ? 'iso-8601'
      : undefined;

  const formatFromDescription = iso8601FromDescription ?? isoFormatFromDescription;

  const slug = formatRaw ?? formatFromDescription;
  if (!slug) {
    return undefined;
  }

  let display: string;
  switch (slug) {
    case 'date-time':
    case 'iso-8601':
      display = 'ISO 8601';
      break;
    case 'uuid':
      display = 'UUID';
      break;
    default:
      display = slug.replace(/[_-]/g, ' ');
      display = display.charAt(0).toUpperCase() + display.slice(1);
      break;
  }
  return {
    display: display.replace(/\b\w/g, (char) => char.toUpperCase()),
    slug,
  };
}

export function toProxyMethodName(toolName: string): string {
  return toolName
    .replace(/[-_](\w)/g, (_, char: string) => char.toUpperCase())
    .replace(/^(\w)/, (match) => match.toLowerCase());
}

export function toCliOption(property: string): string {
  const normalized = property
    .replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)
    .replace(/_/g, '-')
    // A leading uppercase letter or underscore would otherwise produce `---flag`, which
    // commander rejects while the generated command is being built.
    .replace(/^-+/, '');
  // Every character of a property such as `___` normalizes away, and commander rejects the
  // `--` that name would spell. The stem stands in for the whole name, so `assignCliNames`
  // sees it before it hands out suffixes and a schema declaring `option` beside `___` still
  // gets two distinct flags.
  return normalized === '' ? EMPTY_CLI_OPTION_STEM : normalized;
}

export const toolsTestHelpers = {
  getEnumValues,
  getDescriptorDefault,
  buildPlaceholder,
  buildExampleValue,
  pickExampleLiteral,
  buildFallbackLiteral,
};
