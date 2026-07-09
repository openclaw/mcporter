#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
VERSION=${1:-}
RUNNER=${MCP_RUNNER:-"$ROOT/runner"}
OUT_DIR=${MCPORTER_RELEASE_OUT_DIR:-"$ROOT/dist-release"}
TEAM_ID=FWJYW4S8P8
EXPECTED_AUTHORITY="Developer ID Application: OpenClaw Foundation ($TEAM_ID)"
CODESIGN_IDENTITY=${CODESIGN_IDENTITY:-${MAC_RELEASE_CODESIGN_IDENTITY:-}}

if [[ ! "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: $0 vX.Y.Z" >&2
  exit 2
fi
[[ "$(uname -s)" == Darwin ]] || {
  echo "official release packaging must run on macOS" >&2
  exit 1
}
[[ "$(uname -m)" == arm64 ]] || {
  echo "official packaging requires Apple Silicon with Rosetta for x86_64 execution proof" >&2
  exit 1
}
[[ "${CODESIGN_IDENTITY:-}" == "$EXPECTED_AUTHORITY" ]] || {
  echo "official releases require $EXPECTED_AUTHORITY" >&2
  exit 1
}
[[ -n "${NOTARYTOOL_KEYCHAIN_PROFILE:-}" ]] || {
  echo "NOTARYTOOL_KEYCHAIN_PROFILE is required for official releases" >&2
  exit 1
}

for tool in bun git node pnpm shasum tar; do
  command -v "$tool" >/dev/null || {
    echo "missing required tool: $tool" >&2
    exit 1
  }
done

cd "$ROOT"
release_version=${VERSION#v}
package_version=$(node -p "require('./package.json').version")
[[ "$package_version" == "$release_version" ]] || {
  echo "package.json version $package_version does not match $VERSION" >&2
  exit 1
}

head_commit=$(git rev-parse HEAD)
tag_commit=$(git rev-parse "refs/tags/$VERSION^{commit}" 2>/dev/null) || {
  echo "release tag does not exist locally: $VERSION" >&2
  exit 1
}
[[ "$head_commit" == "$tag_commit" ]] || {
  echo "HEAD does not match release tag $VERSION" >&2
  exit 1
}
[[ -z "$(git status --porcelain --untracked-files=normal)" ]] || {
  echo "release checkout is not clean" >&2
  exit 1
}
git -c gpg.format=ssh \
  -c gpg.ssh.allowedSignersFile="$ROOT/.github/release-allowed-signers" \
  tag -v "$VERSION" >/dev/null 2>&1 || {
  echo "release tag is not signed by an allowed maintainer key: $VERSION" >&2
  exit 1
}

if [[ "$OUT_DIR" != /* ]]; then
  OUT_DIR="$ROOT/$OUT_DIR"
fi
[[ ! -e "$OUT_DIR" ]] || {
  echo "refusing to overwrite existing release output: $OUT_DIR" >&2
  exit 1
}

STAGE=$(mktemp -d "$ROOT/.release-stage.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
PAYLOAD="$STAGE/payload"
BUILD_ROOT="$STAGE/build"
mkdir -p "$PAYLOAD" "$BUILD_ROOT"

# dist/ is ignored, so never trust whatever happens to be present in the
# checkout. Finish the credential-free npm payload before any signing or Apple
# submission, then carry those exact bytes through every later gate.
"$RUNNER" pnpm clean
"$RUNNER" pnpm build
for required_file in dist/cli.js dist/cli.d.ts dist/index.js dist/index.d.ts; do
  [[ -s "$required_file" ]] || {
    echo "required npm package output is missing: $required_file" >&2
    exit 1
  }
done
[[ -x dist/cli.js ]] || {
  echo "npm CLI entry is not executable: dist/cli.js" >&2
  exit 1
}

NPM_CONFIG_IGNORE_SCRIPTS=true "$RUNNER" pnpm pack --pack-destination "$PAYLOAD"
npm_archive="mcporter-${release_version}.tgz"
[[ -f "$PAYLOAD/$npm_archive" ]] || {
  echo "pnpm pack did not create $npm_archive" >&2
  exit 1
}

architectures=(arm64 x86_64)
targets=(bun-darwin-arm64 bun-darwin-x64-baseline)
for index in "${!architectures[@]}"; do
  release_arch=${architectures[$index]}
  target=${targets[$index]}
  build_dir="$BUILD_ROOT/$release_arch"
  binary="$build_dir/mcporter"
  archive_name="mcporter_${release_version}_darwin_${release_arch}.tar.gz"
  mkdir -p "$build_dir"

  "$RUNNER" bun scripts/build-bun.ts --target "$target" --output "$binary"
  MCPORTER_OFFICIAL_RELEASE=1 "$ROOT/scripts/codesign-native.sh" "$binary"
  tar -czf "$PAYLOAD/$archive_name" -C "$build_dir" mcporter
done

bun_version=$(bun --version)
node_version=$(node --version)
pnpm_version=$(pnpm --version)
host_version=$(sw_vers -productVersion)
RELEASE_PAYLOAD="$PAYLOAD" \
RELEASE_VERSION="$release_version" \
RELEASE_TAG="$VERSION" \
RELEASE_COMMIT="$head_commit" \
BUN_VERSION="$bun_version" \
NODE_VERSION="$node_version" \
PNPM_VERSION="$pnpm_version" \
HOST_VERSION="$host_version" \
node <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = process.env.RELEASE_PAYLOAD;
const version = process.env.RELEASE_VERSION;
const names = {
  arm64: `mcporter_${version}_darwin_arm64.tar.gz`,
  x86_64: `mcporter_${version}_darwin_x86_64.tar.gz`,
  npm: `mcporter-${version}.tgz`,
};
const sha256 = (name) => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex');
const releaseAssets = [names.arm64, names.x86_64, names.npm, 'checksums.txt', 'provenance.json'].sort();
const payloads = [
  {
    name: names.arm64,
    sha256: sha256(names.arm64),
    platform: 'darwin',
    arch: 'arm64',
    target: 'bun-darwin-arm64',
    identifier: 'org.openclaw.mcporter',
    teamId: 'FWJYW4S8P8',
    notarized: true,
  },
  {
    name: names.x86_64,
    sha256: sha256(names.x86_64),
    platform: 'darwin',
    arch: 'x86_64',
    target: 'bun-darwin-x64-baseline',
    identifier: 'org.openclaw.mcporter',
    teamId: 'FWJYW4S8P8',
    notarized: true,
  },
  { name: names.npm, sha256: sha256(names.npm), format: 'npm' },
];
const provenance = {
  schemaVersion: 1,
  repository: 'openclaw/mcporter',
  version,
  tag: process.env.RELEASE_TAG,
  commit: process.env.RELEASE_COMMIT,
  sourceTree: 'clean',
  codeSignature: {
    identity: 'Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)',
    identifier: 'org.openclaw.mcporter',
    teamId: 'FWJYW4S8P8',
    hardenedRuntime: true,
    timestamp: true,
    entitlements: [
      'com.apple.security.cs.allow-jit',
      'com.apple.security.cs.allow-unsigned-executable-memory',
    ],
  },
  builder: {
    platform: 'darwin',
    arch: 'arm64',
    macOS: process.env.HOST_VERSION,
    bun: process.env.BUN_VERSION,
    node: process.env.NODE_VERSION,
    pnpm: process.env.PNPM_VERSION,
  },
  releaseAssets,
  payloads,
};
fs.writeFileSync(path.join(root, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`, { mode: 0o644 });
NODE

checksums="$PAYLOAD/checksums.txt"
: >"$checksums"
for name in \
  "mcporter_${release_version}_darwin_arm64.tar.gz" \
  "mcporter_${release_version}_darwin_x86_64.tar.gz" \
  "$npm_archive" \
  provenance.json; do
  shasum -a 256 "$PAYLOAD/$name" | awk -v name="$name" '{ print $1 "  " name }' >>"$checksums"
done

env -u GH_TOKEN -u GITHUB_TOKEN \
  MCPORTER_VERIFY_EXEC_ARCH=all \
  "$ROOT/scripts/verify-release.sh" "$VERSION" "$PAYLOAD"

mv "$PAYLOAD" "$OUT_DIR"
echo "Verified release artifacts: $OUT_DIR"
