import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const codec = await import(
  pathToFileURL(path.join(path.resolve(process.argv[2]), 'dist', 'oauth-vault-encryption.js')).href
);
const password = 'packaged-vault-verifier-password-2026';
const kid = codec.vaultSecretKid('verify|0000000000000000', ['tokens', 'refresh_token']);
const token = await codec.sealVaultSecret('synthetic-refresh-token', kid, password);
assert.equal(codec.isVaultSecretJwe(token), true, 'installed package did not produce a vault JWE');
assert.equal(
  await codec.openVaultSecret(token, kid, password),
  'synthetic-refresh-token',
  'installed package did not round-trip the value'
);
console.log('Installed npm package seals and opens OAuth vault values.');
