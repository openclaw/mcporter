import http from 'node:http';
import https from 'node:https';
import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

const MAX_REDIRECTS = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

export const nodeHttp1Fetch: FetchLike = async (input, init = {}) => {
  return nodeHttp1FetchWithRedirects(input, init, 0);
};

async function nodeHttp1FetchWithRedirects(
  input: string | URL,
  init: RequestInit,
  redirectCount: number
): Promise<Response> {
  const url = input instanceof URL ? input : new URL(input);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`node-http1 fetch only supports http: and https: URLs, got ${url.protocol}`);
  }
  if (init.signal?.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError');
  }

  const headers = normalizeRequestHeaders(init.headers);
  const body = await materializeRequestBody(init.body);
  if (body !== undefined && !hasHeader(headers, 'content-length') && !hasHeader(headers, 'transfer-encoding')) {
    headers['content-length'] = String(Buffer.byteLength(body));
  }

  return new Promise<Response>((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(
      url,
      {
        method: init.method ?? 'GET',
        headers,
      },
      (response) => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) {
              responseHeaders.append(key, item);
            }
          } else if (value !== undefined) {
            responseHeaders.set(key, String(value));
          }
        }
        const status = response.statusCode ?? 502;
        const location = responseHeaders.get('location');
        if (REDIRECT_STATUSES.has(status) && location && init.redirect !== 'manual') {
          response.resume();
          if (init.redirect === 'error') {
            reject(new TypeError(`Redirect encountered for ${url.href}`));
            return;
          }
          if (redirectCount >= MAX_REDIRECTS) {
            reject(new TypeError(`Too many redirects while fetching ${url.href}`));
            return;
          }
          let nextUrl: URL;
          try {
            nextUrl = new URL(location, url);
          } catch (error) {
            reject(error);
            return;
          }
          resolve(
            nodeHttp1FetchWithRedirects(nextUrl, buildRedirectInit(init, status, url, nextUrl), redirectCount + 1)
          );
          return;
        }
        if (NULL_BODY_STATUSES.has(status)) {
          response.resume();
        }
        resolve(
          new Response(
            NULL_BODY_STATUSES.has(status) ? null : (Readable.toWeb(response) as unknown as ReadableStream),
            {
              status,
              statusText: response.statusMessage,
              headers: responseHeaders,
            }
          )
        );
      }
    );

    const abort = () => {
      request.destroy(new DOMException('The operation was aborted.', 'AbortError'));
    };
    init.signal?.addEventListener('abort', abort, { once: true });
    request.once('close', () => init.signal?.removeEventListener('abort', abort));
    request.once('error', reject);
    if (body !== undefined) {
      request.write(body);
    }
    request.end();
  });
}

function buildRedirectInit(init: RequestInit, status: number, currentUrl: URL, nextUrl: URL): RequestInit {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  if (currentUrl.origin !== nextUrl.origin) {
    stripCrossOriginRedirectHeaders(headers);
  }
  if ((status === 301 || status === 302 || status === 303) && method !== 'GET' && method !== 'HEAD') {
    headers.delete('content-length');
    headers.delete('content-type');
    return {
      ...init,
      method: 'GET',
      body: null,
      headers,
    };
  }
  return {
    ...init,
    headers,
  };
}

function stripCrossOriginRedirectHeaders(headers: Headers): void {
  headers.delete('authorization');
  headers.delete('cookie');
  headers.delete('proxy-authorization');
}

function normalizeRequestHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const normalized: Record<string, string> = {};
  if (!headers) {
    return normalized;
  }
  new Headers(headers).forEach((value, key) => {
    normalized[key] = value;
  });
  return normalized;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

async function materializeRequestBody(body: RequestInit['body']): Promise<Buffer | string | undefined> {
  if (body == null) {
    return undefined;
  }
  if (typeof body === 'string') {
    return body;
  }
  if (body instanceof URLSearchParams) {
    return body.toString();
  }
  if (body instanceof Blob) {
    return Buffer.from(await body.arrayBuffer());
  }
  if (body instanceof ArrayBuffer) {
    return Buffer.from(body);
  }
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  throw new TypeError('node-http1 fetch does not support streaming request bodies.');
}
