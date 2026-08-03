#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const [releasePath, armProofPath, x86ProofPath, assetDirectory, tag, commit] = process.argv.slice(2);

if (![releasePath, armProofPath, x86ProofPath, assetDirectory, tag, commit].every(Boolean)) {
  throw new Error(
    'usage: verify-published-release-proof.mjs <release-json> <arm-proof> <x86-proof> <asset-dir> <tag> <commit>'
  );
}

if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
  throw new Error(`invalid stable release tag: ${tag}`);
}

const release = JSON.parse(readFileSync(releasePath, 'utf8'));
const armProof = JSON.parse(readFileSync(armProofPath, 'utf8'));
const x86Proof = JSON.parse(readFileSync(x86ProofPath, 'utf8'));
const version = tag.slice(1);
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const expectedNames = [
  `mcporter_${version}_darwin_arm64.tar.gz`,
  `mcporter_${version}_darwin_x86_64.tar.gz`,
  `mcporter-${version}.tgz`,
  'checksums.txt',
  'provenance.json',
].toSorted(byCodeUnit);
const publishedAssets = [...(release.assets ?? [])].toSorted((a, b) => byCodeUnit(a.name, b.name));

if (
  release.tag_name !== tag ||
  release.draft !== false ||
  release.prerelease !== false ||
  typeof release.published_at !== 'string' ||
  JSON.stringify(publishedAssets.map((asset) => asset.name)) !== JSON.stringify(expectedNames)
) {
  throw new Error('published GitHub Release metadata or asset inventory is invalid');
}

function validateProof(proof, arch) {
  const assets = [...(proof.assets ?? [])].toSorted((a, b) => byCodeUnit(a.name, b.name));
  if (
    proof.schemaVersion !== 2 ||
    proof.arch !== arch ||
    proof.repository !== process.env.GITHUB_REPOSITORY ||
    proof.tag !== tag ||
    proof.commit !== commit ||
    proof.releaseId !== release.id ||
    JSON.stringify(assets.map((asset) => asset.name)) !== JSON.stringify(expectedNames) ||
    assets.length !== publishedAssets.length
  ) {
    throw new Error(`published release is not bound to the protected ${arch} native proof`);
  }
  return assets;
}

const armAssets = validateProof(armProof, 'arm64');
const x86Assets = validateProof(x86Proof, 'x86_64');
const proofVector = (assets) => assets.map(({ id, name, size, sha256 }) => ({ id, name, size, sha256 }));

if (JSON.stringify(proofVector(armAssets)) !== JSON.stringify(proofVector(x86Assets))) {
  throw new Error('arm64 and x86_64 native proof artifacts disagree on the verified asset set');
}

for (let index = 0; index < armAssets.length; index += 1) {
  const proofAsset = armAssets[index];
  const releaseAsset = publishedAssets[index];
  const assetPath = join(assetDirectory, proofAsset.name);
  const size = statSync(assetPath).size;
  const sha256 = createHash('sha256').update(readFileSync(assetPath)).digest('hex');

  if (
    proofAsset.id !== releaseAsset.id ||
    proofAsset.name !== releaseAsset.name ||
    proofAsset.size !== releaseAsset.size ||
    size !== proofAsset.size ||
    sha256 !== proofAsset.sha256
  ) {
    throw new Error(`published asset changed after native verification: ${proofAsset.name}`);
  }
}

console.log(`Verified published ${tag} against both protected native proof artifacts.`);
