/** Compare a fresh DCR response only; never change the actual callback URI. */
export function matchesFreshLoopbackRedirect(returned: string, requested: URL): boolean {
  let redirect: URL;
  try {
    redirect = new URL(returned);
  } catch {
    return false;
  }
  if (requested.protocol !== 'http:' || redirect.protocol !== 'http:') return false;
  if (!['127.0.0.1', '[::1]', 'localhost'].includes(requested.hostname)) return false;
  // RFC 8252 permits loopback port variation. Fastmail additionally represents
  // a native IPv4 loopback callback as portless localhost in its DCR response.
  const sameHost = redirect.hostname === requested.hostname;
  const fastmailShape = requested.hostname === '127.0.0.1' && redirect.hostname === 'localhost' && redirect.port === '';
  if (!sameHost && !fastmailShape) return false;
  redirect.hostname = requested.hostname;
  redirect.port = requested.port;
  return redirect.href === requested.href;
}
