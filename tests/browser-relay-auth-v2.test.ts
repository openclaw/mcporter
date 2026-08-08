import { describe, expect, it } from 'vitest';
import {
  canonicalizeBrowserRelayProof,
  createBrowserRelayProof,
  deriveBrowserRelayKeyId,
  verifyBrowserRelayProof,
} from '../src/browser-relay-auth-v2.js';

const KEY = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
const FIELDS = {
  keyId: 'Yw3NKWbEM2aRElRIu7JbT_',
  instanceId: 'EREREREREREREREREREREQ',
  sessionId: 'IiIiIiIiIiIiIiIiIiIiIg',
  clientNonce: 'MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM',
  serverNonce: 'REREREREREREREREREREREREREREREREREREREREREQ',
  issuedAtMs: 1_786_123_456_000,
  expiresAtMs: 1_786_123_466_000,
  role: 'extension',
  transport: 'websocket',
  method: 'GET',
  resource: '/extension?profile=chrome',
  flow: 'extension',
} as const;

describe('Browser Relay Authentication v2 common vectors', () => {
  it('matches the frozen Node/WebCrypto vector shared with OpenClaw', () => {
    expect(deriveBrowserRelayKeyId(KEY)).toBe('Yw3NKWbEM2aRElRIu7JbT_');
    expect(canonicalizeBrowserRelayProof('server', FIELDS).toString('utf8')).toBe(
      '["openclaw.browser-relay.auth",2,"server","Yw3NKWbEM2aRElRIu7JbT_","EREREREREREREREREREREQ","IiIiIiIiIiIiIiIiIiIiIg","MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM","REREREREREREREREREREREREREREREREREREREREREQ",1786123456000,1786123466000,"extension","websocket","GET","/extension?profile=chrome","extension"]'
    );
    const serverProof = createBrowserRelayProof(KEY, 'server', FIELDS);
    const clientProof = createBrowserRelayProof(KEY, 'client', FIELDS);
    expect(serverProof).toBe('ynhaAA_l2HkOGXQ8DvIWfzWwwGjDcV93aumHNe_NM-Q');
    expect(clientProof).toBe('Rl8TStMYlPLxJPDYwSe__mtEjgMf1C4TM-ZN6sUipZ4');
    expect(createBrowserRelayProof(KEY, 'accept', FIELDS, clientProof)).toBe(
      '1R5MpHs6qnAdc0_X6vKBwj91tlRoWfNuGXaNfSD7VnI'
    );
  });

  it('uses constant-length proof validation and binds every canonical field', () => {
    const proof = createBrowserRelayProof(KEY, 'server', FIELDS);
    expect(verifyBrowserRelayProof(KEY, 'server', FIELDS, proof)).toBe(true);
    for (const [key, value] of Object.entries(FIELDS)) {
      const altered = { ...FIELDS, [key]: typeof value === 'number' ? value + 1 : `${value}x` };
      expect(verifyBrowserRelayProof(KEY, 'server', altered, proof), key).toBe(false);
    }
    expect(verifyBrowserRelayProof(KEY, 'server', FIELDS, `${proof.slice(0, -1)}A`)).toBe(false);
    expect(verifyBrowserRelayProof(KEY, 'server', FIELDS, 'not-a-proof')).toBe(false);
  });
});
