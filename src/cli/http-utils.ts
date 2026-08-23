const DOMAIN_WITH_PATH_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*)(?::\d+)?\//;

export function normalizeHttpUrlCandidate(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const hasScheme = /^https?:\/\//i.test(trimmed);
  const candidate = hasScheme ? trimmed : DOMAIN_WITH_PATH_PATTERN.test(trimmed) ? `https://${trimmed}` : null;
  if (!candidate) {
    return undefined;
  }
  try {
    const url = new URL(candidate);
    return url.href;
  } catch {
    return undefined;
  }
}

export function looksLikeHttpUrl(value?: string): boolean {
  return Boolean(normalizeHttpUrlCandidate(value));
}

export function splitHttpToolSelector(input: string): { baseUrl: string; tool: string } | null {
  const trimmed = input.trim();
  const candidate = (() => {
    const openParen = trimmed.indexOf('(');
    if (openParen === -1) {
      return trimmed;
    }
    return trimmed.slice(0, openParen);
  })();
  const normalized = normalizeHttpUrlCandidate(candidate);
  if (!normalized) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return null;
  }
  const pathname = url.pathname || '/';
  const lastSlash = pathname.lastIndexOf('/');
  const segment = pathname.slice(lastSlash + 1);
  const dotIndex = segment.lastIndexOf('.');
  if (dotIndex <= 0) {
    return null;
  }
  const tool = segment.slice(dotIndex + 1);
  if (!tool || !/^[A-Za-z0-9_-]+$/.test(tool)) {
    return null;
  }
  const baseSegment = segment.slice(0, dotIndex);
  if (!baseSegment) {
    return null;
  }
  const basePath = `${pathname.slice(0, Math.max(0, lastSlash + 1))}${baseSegment}`;
  // Serialize through URL rather than concatenating the origin, so the query and fragment the
  // user typed reach the server instead of being dropped from the connection target.
  url.pathname = basePath.startsWith('/') ? basePath : `/${basePath}`;
  return { baseUrl: url.href, tool };
}

export function normalizeHttpUrl(value: string | URL): string | undefined {
  try {
    const url = value instanceof URL ? new URL(value.href) : new URL(value);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.replace(/^www\./i, '').toLowerCase();
    if (!url.pathname) {
      url.pathname = '/';
    }
    return url.href;
  } catch {
    return undefined;
  }
}

export function extractHttpServerTarget(value: string): string | undefined {
  const split = splitHttpToolSelector(value);
  if (split) {
    return split.baseUrl;
  }
  const normalized = normalizeHttpUrlCandidate(value);
  return normalized ?? undefined;
}
