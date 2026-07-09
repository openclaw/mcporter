#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
RUNNER=${MCP_RUNNER:-"$ROOT/runner"}
VERSION=${VERSION:-$(node -p "require('$ROOT/package.json').version")}
TAG="v$VERSION"
REPOSITORY=openclaw/mcporter
MAC_RELEASE_HELPER=${MAC_RELEASE_HELPER:-}

if [[ -z "$MAC_RELEASE_HELPER" ]]; then
  MAC_RELEASE_HELPER=$(command -v mac-release || true)
fi
if [[ -z "$MAC_RELEASE_HELPER" && -x "$ROOT/../agent-scripts/skills/release-mac-app/scripts/mac-release" ]]; then
  MAC_RELEASE_HELPER="$ROOT/../agent-scripts/skills/release-mac-app/scripts/mac-release"
fi
MCPORTER_RELEASE_TMP=
VERIFIED_PUBLIC_NPM_ARCHIVE=
trap '[[ -z "${MCPORTER_RELEASE_TMP:-}" ]] || rm -rf "$MCPORTER_RELEASE_TMP"' EXIT

banner() { printf '\n==== %s ====\n' "$1"; }
run() { printf '>>' >&2; printf ' %q' "$@" >&2; printf '\n' >&2; "$@"; }

phase_gates() {
  banner "Credential-free gates"
  run "$RUNNER" pnpm check
  run "$RUNNER" pnpm test
  run "$RUNNER" pnpm build
  run "$RUNNER" pnpm build:bun
  run "$ROOT/scripts/test-release.sh"
  run "$RUNNER" pnpm audit
}

phase_native() {
  banner "Signed and notarized native artifacts"
  [[ -x "$MAC_RELEASE_HELPER" ]] || {
    echo "release-mac-app helper not found; set MAC_RELEASE_HELPER or install mac-release on PATH" >&2
    exit 1
  }
  [[ -n "${NOTARYTOOL_KEYCHAIN_PROFILE:-}" ]] || {
    echo "NOTARYTOOL_KEYCHAIN_PROFILE must name the pre-existing release profile" >&2
    exit 1
  }
  run "$MAC_RELEASE_HELPER" codesign-run -- "$ROOT/scripts/package-release.sh" "$TAG"
}

phase_verify_local() {
  banner "Local exact-tag native verification"
  run env -u GH_TOKEN -u GITHUB_TOKEN \
    MCPORTER_VERIFY_EXEC_ARCH=all \
    "$ROOT/scripts/verify-release.sh" "$TAG" "$ROOT/dist-release"
}

verify_public_native_proof() {
  local run_id=${NATIVE_VERIFIER_RUN_ID:-}
  [[ "$run_id" =~ ^[0-9]+$ ]] || {
    echo "NATIVE_VERIFIER_RUN_ID must identify the successful protected verifier run" >&2
    exit 1
  }
  for tool in cmp gh jq node shasum; do
    command -v "$tool" >/dev/null || {
      echo "missing required tool: $tool" >&2
      exit 1
    }
  done

  local default_branch tag_commit proof release expected_assets actual_assets manifest manifest_arm manifest_x86 remote_assets
  default_branch=$(gh api "repos/$REPOSITORY" --jq .default_branch)
  tag_commit=$(git -C "$ROOT" rev-parse "refs/tags/$TAG^{commit}")
  proof=$(gh run view "$run_id" \
    --repo "$REPOSITORY" \
    --json conclusion,displayTitle,event,headBranch,headSha,workflowName)
  [[ "$(jq -r '.conclusion' <<<"$proof")" == success ]]
  [[ "$(jq -r '.event' <<<"$proof")" == workflow_dispatch ]]
  [[ "$(jq -r '.headBranch' <<<"$proof")" == "$default_branch" ]]
  [[ "$(jq -r '.headSha' <<<"$proof")" == "$tag_commit" ]]
  [[ "$(jq -r '.workflowName' <<<"$proof")" == 'Verify Release Assets' ]]
  [[ "$(jq -r '.displayTitle' <<<"$proof")" == "Verify release assets $TAG" ]]

  release=$(gh api "repos/$REPOSITORY/releases/tags/$TAG")
  [[ "$(jq -r '.draft' <<<"$release")" == false ]]
  [[ "$(jq -r '.prerelease' <<<"$release")" == false ]]
  expected_assets=$(printf '%s\n' \
    "mcporter_${VERSION}_darwin_arm64.tar.gz" \
    "mcporter_${VERSION}_darwin_x86_64.tar.gz" \
    "mcporter-${VERSION}.tgz" \
    checksums.txt \
    provenance.json | LC_ALL=C sort)
  actual_assets=$(jq -r '.assets[].name' <<<"$release" | LC_ALL=C sort)
  [[ "$actual_assets" == "$expected_assets" ]] || {
    echo "published GitHub release asset inventory mismatch" >&2
    exit 1
  }

  MCPORTER_RELEASE_TMP=$(mktemp -d "${TMPDIR:-/tmp}/mcporter-published-proof.XXXXXX")
  mkdir -p "$MCPORTER_RELEASE_TMP/proof/arm64" "$MCPORTER_RELEASE_TMP/proof/x86_64" "$MCPORTER_RELEASE_TMP/assets"
  printf '%s\n' "$release" >"$MCPORTER_RELEASE_TMP/release.json"
  gh run download "$run_id" \
    --repo "$REPOSITORY" \
    --name verified-assets-arm64 \
    --dir "$MCPORTER_RELEASE_TMP/proof/arm64"
  gh run download "$run_id" \
    --repo "$REPOSITORY" \
    --name verified-assets-x86_64 \
    --dir "$MCPORTER_RELEASE_TMP/proof/x86_64"
  manifest_arm="$MCPORTER_RELEASE_TMP/proof/arm64/verified-assets.json"
  manifest_x86="$MCPORTER_RELEASE_TMP/proof/x86_64/verified-assets.json"
  manifest="$manifest_arm"
  remote_assets="$MCPORTER_RELEASE_TMP/assets"
  node - "$manifest_arm" "$manifest_x86" "$MCPORTER_RELEASE_TMP/release.json" "$TAG" "$tag_commit" <<'NODE'
const fs = require('node:fs');
const armManifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const x86Manifest = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const release = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
const tag = process.argv[5];
const commit = process.argv[6];
const version = tag.slice(1);
const expectedNames = [
  `mcporter_${version}_darwin_arm64.tar.gz`,
  `mcporter_${version}_darwin_x86_64.tar.gz`,
  `mcporter-${version}.tgz`,
  'checksums.txt',
  'provenance.json',
].sort();
const releaseAssets = [...(release.assets ?? [])].sort((a, b) => a.name.localeCompare(b.name));
function validateManifest(manifest, arch) {
  const assets = [...(manifest.assets ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  if (
    manifest.schemaVersion !== 2 ||
    manifest.arch !== arch ||
    manifest.repository !== 'openclaw/mcporter' ||
    manifest.tag !== tag ||
    manifest.commit !== commit ||
    manifest.releaseId !== release.id ||
    JSON.stringify(assets.map((asset) => asset.name)) !== JSON.stringify(expectedNames) ||
    assets.length !== releaseAssets.length
  ) {
    throw new Error(`published release is not bound to the protected ${arch} native proof`);
  }
  return assets;
}
const armAssets = validateManifest(armManifest, 'arm64');
const x86Assets = validateManifest(x86Manifest, 'x86_64');
const proofVector = (assets) => assets.map(({ id, name, size, sha256 }) => ({ id, name, size, sha256 }));
if (JSON.stringify(proofVector(armAssets)) !== JSON.stringify(proofVector(x86Assets))) {
  throw new Error('arm64 and x86_64 native proof artifacts disagree on the verified asset set');
}
for (let index = 0; index < armAssets.length; index += 1) {
  const verified = armAssets[index];
  const published = releaseAssets[index];
  if (
    verified.id !== published.id ||
    verified.name !== published.name ||
    verified.size !== published.size ||
    !/^[0-9a-f]{64}$/.test(verified.sha256)
  ) {
    throw new Error(`published asset identity changed after verification: ${verified.name}`);
  }
}
NODE

  while IFS=$'\t' read -r asset_id asset_name expected_sha; do
    gh api \
      --header 'Accept: application/octet-stream' \
      "repos/$REPOSITORY/releases/assets/$asset_id" >"$remote_assets/$asset_name"
    [[ "$(shasum -a 256 "$remote_assets/$asset_name" | awk '{ print $1 }')" == "$expected_sha" ]] || {
      echo "published asset digest changed after native verification: $asset_name" >&2
      exit 1
    }
  done < <(jq -r '.assets[] | [.id, .name, .sha256] | @tsv' "$manifest")

  env -u GH_TOKEN -u GITHUB_TOKEN \
    MCPORTER_VERIFY_EXEC_ARCH=all \
    "$ROOT/scripts/verify-release.sh" "$TAG" "$remote_assets"

  VERIFIED_PUBLIC_NPM_ARCHIVE="$remote_assets/mcporter-$VERSION.tgz"
  cmp "$ROOT/dist-release/mcporter-$VERSION.tgz" "$VERIFIED_PUBLIC_NPM_ARCHIVE" >/dev/null || {
    echo "published npm asset does not match the locally verified release tarball" >&2
    exit 1
  }
}

phase_publish_npm() {
  banner "Publish npm after native proof"
  phase_verify_local
  verify_public_native_proof
  local npm_archive local_integrity existing_version registry_version registry_integrity registry_ready
  npm_archive=$VERIFIED_PUBLIC_NPM_ARCHIVE
  [[ -f "$npm_archive" ]] || {
    echo "missing verified npm artifact: $npm_archive" >&2
    exit 1
  }
  local_integrity=$(NPM_ARCHIVE="$npm_archive" node - <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const digest = crypto.createHash('sha512').update(fs.readFileSync(process.env.NPM_ARCHIVE)).digest('base64');
process.stdout.write(`sha512-${digest}`);
NODE
  )
  existing_version=$(npm view "mcporter@$VERSION" version 2>/dev/null || true)
  if [[ "$existing_version" == "$VERSION" ]]; then
    echo "mcporter@$VERSION already exists; verifying immutable registry metadata instead of republishing."
  elif ! NPM_CONFIG_IGNORE_SCRIPTS=true run "$RUNNER" pnpm publish "$npm_archive" --tag latest; then
    echo "npm publish returned non-zero; checking whether the immutable version was accepted before retrying." >&2
  fi

  registry_ready=0
  for _ in {1..20}; do
    registry_version=$(npm view "mcporter@$VERSION" version 2>/dev/null || true)
    registry_integrity=$(npm view "mcporter@$VERSION" dist.integrity 2>/dev/null || true)
    if [[ "$registry_version" == "$VERSION" && "$registry_integrity" == "$local_integrity" ]]; then
      registry_ready=1
      break
    fi
    if [[ "$registry_version" == "$VERSION" && -n "$registry_integrity" && "$registry_integrity" != "$local_integrity" ]]; then
      echo "npm registry integrity does not match the verified release tarball" >&2
      exit 1
    fi
    sleep 3
  done
  [[ "$registry_ready" == 1 ]] || {
    echo "npm registry did not expose the verified release artifact before timeout" >&2
    exit 1
  }
  [[ "$(npm view mcporter dist-tags.latest)" == "$VERSION" ]] || {
    echo "npm latest dist-tag does not point to $VERSION" >&2
    exit 1
  }
  run npm view "mcporter@$VERSION" dist.tarball dist.integrity time
}

phase_smoke() {
  banner "Published npm smoke"
  MCPORTER_SMOKE_TMP=$(mktemp -d "${TMPDIR:-/tmp}/mcporter-empty.XXXXXX")
  trap 'rm -rf "${MCPORTER_SMOKE_TMP:?}"' EXIT
  (
    cd "$MCPORTER_SMOKE_TMP"
    npx --yes "mcporter@$VERSION" generate-cli "npx -y chrome-devtools-mcp" --compile
    ./chrome-devtools-mcp --help | head -n 5
  )
}

usage() {
  cat <<'EOF'
Usage: scripts/release.sh <phase>

Phases:
  gates        credential-free check, test, build, release-contract test, audit
  native       exact signed tag -> dual-architecture signed/notarized artifacts
  verify-local reverify local artifact inventory with GitHub tokens absent
  publish-npm  require local + protected GitHub native proof, then publish npm
  smoke        published npm empty-directory compile smoke

There is intentionally no combined, tag, GitHub publish, or Homebrew phase.
Those irreversible steps require separate serialized release gates.

Set MAC_RELEASE_HELPER when mac-release is neither on PATH nor in a sibling
agent-scripts checkout.
EOF
}

case "${1:-}" in
  gates) phase_gates ;;
  native) phase_native ;;
  verify-local) phase_verify_local ;;
  publish-npm) phase_publish_npm ;;
  smoke) phase_smoke ;;
  *) usage; exit 2 ;;
esac
