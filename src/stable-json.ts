export function stableJsonStringify(value: unknown, space?: number): string {
  const json = JSON.stringify(sortJsonValue(value), undefined, space);
  if (json === undefined) {
    throw new TypeError('Cannot serialize unsupported JSON root value.');
  }
  return json;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJsonValue(entry));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).toSorted()) {
    const entry = value[key];
    if (entry !== undefined) {
      result[key] = sortJsonValue(entry);
    }
  }
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
