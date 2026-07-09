#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
VERSION=${1:-}
OUT_DIR=${2:-"$ROOT/dist-release"}
EXEC_ARCH=${MCPORTER_VERIFY_EXEC_ARCH:-all}
IDENTIFIER=org.openclaw.mcporter
TEAM_ID=FWJYW4S8P8
EXPECTED_AUTHORITY="Developer ID Application: OpenClaw Foundation ($TEAM_ID)"
REQUIREMENT="identifier \"$IDENTIFIER\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"$TEAM_ID\""

if [[ ! "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: $0 vX.Y.Z [artifact-directory]" >&2
  exit 2
fi
[[ "$EXEC_ARCH" == all || "$EXEC_ARCH" == arm64 || "$EXEC_ARCH" == x86_64 ]] || {
  echo "MCPORTER_VERIFY_EXEC_ARCH must be all, arm64, or x86_64" >&2
  exit 2
}
[[ "$(uname -s)" == Darwin ]] || {
  echo "native release verification must run on macOS" >&2
  exit 1
}
[[ -z "${GH_TOKEN:-}" && -z "${GITHUB_TOKEN:-}" ]] || {
  echo "GitHub tokens must be absent during release verification and candidate execution" >&2
  exit 1
}

for tool in codesign git lipo node npm plutil shasum tar; do
  command -v "$tool" >/dev/null || {
    echo "missing required tool: $tool" >&2
    exit 1
  }
done

release_version=${VERSION#v}
package_version=$(node -p "require('$ROOT/package.json').version")
[[ "$package_version" == "$release_version" ]] || {
  echo "package.json version $package_version does not match $VERSION" >&2
  exit 1
}
head_commit=$(git -C "$ROOT" rev-parse HEAD)
tag_commit=$(git -C "$ROOT" rev-parse "refs/tags/$VERSION^{commit}" 2>/dev/null) || {
  echo "release tag does not exist: $VERSION" >&2
  exit 1
}
[[ "$head_commit" == "$tag_commit" ]] || {
  echo "protected verifier HEAD does not match $VERSION" >&2
  exit 1
}
[[ -z "$(git -C "$ROOT" status --porcelain --untracked-files=normal)" ]] || {
  echo "release verifier source checkout is not clean" >&2
  exit 1
}
git -C "$ROOT" \
  -c gpg.format=ssh \
  -c gpg.ssh.allowedSignersFile="$ROOT/.github/release-allowed-signers" \
  tag -v "$VERSION" >/dev/null 2>&1 || {
  echo "release tag is not signed by an allowed maintainer key: $VERSION" >&2
  exit 1
}

arm_archive="mcporter_${release_version}_darwin_arm64.tar.gz"
intel_archive="mcporter_${release_version}_darwin_x86_64.tar.gz"
npm_archive="mcporter-${release_version}.tgz"
expected_assets=$(printf '%s\n' "$arm_archive" "$intel_archive" "$npm_archive" checksums.txt provenance.json | LC_ALL=C sort)
actual_assets=$(find "$OUT_DIR" -mindepth 1 -maxdepth 1 -exec basename {} \; | LC_ALL=C sort)
[[ "$actual_assets" == "$expected_assets" ]] || {
  echo "release asset inventory mismatch" >&2
  diff -u <(printf '%s\n' "$expected_assets") <(printf '%s\n' "$actual_assets") >&2 || true
  exit 1
}

checksums="$OUT_DIR/checksums.txt"
expected_checksum_names=$(printf '%s\n' "$arm_archive" "$intel_archive" "$npm_archive" provenance.json | LC_ALL=C sort)
actual_checksum_names=$(awk 'NF == 2 { print $2 }' "$checksums" | LC_ALL=C sort)
[[ "$actual_checksum_names" == "$expected_checksum_names" ]] || {
  echo "checksum inventory mismatch" >&2
  exit 1
}
awk 'NF != 2 || $1 !~ /^[[:xdigit:]]{64}$/ || $2 ~ /\// { exit 1 }' "$checksums" || {
  echo "checksums must contain one SHA256 and basename per line" >&2
  exit 1
}
(cd "$OUT_DIR" && shasum -a 256 -c checksums.txt)

node - "$OUT_DIR/provenance.json" "$VERSION" "$head_commit" "$checksums" <<'NODE'
const fs = require('node:fs');
const provenance = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const tag = process.argv[3];
const commit = process.argv[4];
const checksumLines = fs.readFileSync(process.argv[5], 'utf8').trim().split(/\n/);
const checksums = new Map(checksumLines.map((line) => {
  const match = line.match(/^([0-9a-fA-F]{64})  ([^/]+)$/);
  if (!match) throw new Error(`invalid checksum line: ${line}`);
  return [match[2], match[1].toLowerCase()];
}));
const version = tag.slice(1);
const expectedAssets = [
  `mcporter_${version}_darwin_arm64.tar.gz`,
  `mcporter_${version}_darwin_x86_64.tar.gz`,
  `mcporter-${version}.tgz`,
  'checksums.txt',
  'provenance.json',
].sort();
if (
  provenance.schemaVersion !== 1 ||
  provenance.repository !== 'openclaw/mcporter' ||
  provenance.version !== version ||
  provenance.tag !== tag ||
  provenance.commit !== commit ||
  provenance.sourceTree !== 'clean' ||
  provenance.codeSignature?.identity !== 'Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)' ||
  provenance.codeSignature?.identifier !== 'org.openclaw.mcporter' ||
  provenance.codeSignature?.teamId !== 'FWJYW4S8P8' ||
  provenance.codeSignature?.hardenedRuntime !== true ||
  provenance.codeSignature?.timestamp !== true ||
  JSON.stringify(provenance.codeSignature?.entitlements) !==
    JSON.stringify([
      'com.apple.security.cs.allow-jit',
      'com.apple.security.cs.allow-unsigned-executable-memory',
    ]) ||
  JSON.stringify(provenance.releaseAssets) !== JSON.stringify(expectedAssets)
) {
  throw new Error('release provenance does not match the exact source/tag/inventory');
}
const payloads = new Map((provenance.payloads ?? []).map((entry) => [entry.name, entry]));
if (payloads.size !== 3) {
  throw new Error('release provenance payload inventory is not exact');
}
for (const name of expectedAssets.filter((entry) => !['checksums.txt', 'provenance.json'].includes(entry))) {
  const payload = payloads.get(name);
  if (!payload || payload.sha256 !== checksums.get(name)) {
    throw new Error(`provenance digest mismatch: ${name}`);
  }
}
const npmName = `mcporter-${version}.tgz`;
if (payloads.get(npmName)?.format !== 'npm') {
  throw new Error(`invalid npm provenance: ${npmName}`);
}
if (
  provenance.builder?.platform !== 'darwin' ||
  provenance.builder?.arch !== 'arm64' ||
  !['macOS', 'bun', 'node', 'pnpm'].every(
    (key) => typeof provenance.builder?.[key] === 'string' && provenance.builder[key].length > 0
  )
) {
  throw new Error('invalid release builder provenance');
}
for (const arch of ['arm64', 'x86_64']) {
  const name = `mcporter_${version}_darwin_${arch}.tar.gz`;
  const payload = payloads.get(name);
  if (
    payload?.platform !== 'darwin' ||
    payload?.arch !== arch ||
    payload?.target !== (arch === 'arm64' ? 'bun-darwin-arm64' : 'bun-darwin-x64-baseline') ||
    payload?.identifier !== 'org.openclaw.mcporter' ||
    payload?.teamId !== 'FWJYW4S8P8' ||
    payload?.notarized !== true
  ) {
    throw new Error(`invalid native provenance: ${name}`);
  }
}
NODE

WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/mcporter-release-verify.XXXXXX")
trap 'rm -rf "$WORK_DIR"' EXIT
npm_stage="$WORK_DIR/npm"
mkdir -p "$npm_stage" "$WORK_DIR/home/config" "$WORK_DIR/home/data" "$WORK_DIR/home/state" "$WORK_DIR/home/cache"
tar -xzf "$OUT_DIR/$npm_archive" -C "$npm_stage"
for required_file in \
  package/package.json \
  package/dist/cli.js \
  package/dist/cli.d.ts \
  package/dist/index.js \
  package/dist/index.d.ts \
  package/README.md \
  package/LICENSE; do
  [[ -s "$npm_stage/$required_file" ]] || {
    echo "npm artifact is missing declared file: $required_file" >&2
    exit 1
  }
done
[[ -x "$npm_stage/package/dist/cli.js" ]] || {
  echo "packed npm CLI is not executable" >&2
  exit 1
}
node - "$npm_stage/package/package.json" "$release_version" <<'NODE'
const fs = require('node:fs');
const pkg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const expectedVersion = process.argv[3];
if (
  pkg.name !== 'mcporter' ||
  pkg.version !== expectedVersion ||
  pkg.bin?.mcporter !== 'dist/cli.js' ||
  pkg.main !== 'dist/index.js' ||
  pkg.module !== 'dist/index.js' ||
  pkg.types !== 'dist/index.d.ts' ||
  pkg.exports?.['.']?.import !== './dist/index.js' ||
  pkg.exports?.['.']?.types !== './dist/index.d.ts' ||
  pkg.exports?.['./cli']?.import !== './dist/cli.js' ||
  pkg.exports?.['./cli']?.types !== './dist/cli.d.ts' ||
  !Array.isArray(pkg.files) ||
  !['dist', 'README.md', 'LICENSE'].every((name) => pkg.files.includes(name))
) {
  throw new Error('npm package declarations do not match the release contract');
}
NODE

npm_smoke="$WORK_DIR/npm-smoke"
mkdir -p "$npm_smoke"
printf '{"private":true}\n' >"$npm_smoke/package.json"
: >"$WORK_DIR/empty-npmrc"
packed_env=(
  env
  -u GH_TOKEN
  -u GITHUB_TOKEN
  HOME="$WORK_DIR/home"
  XDG_CONFIG_HOME="$WORK_DIR/home/config"
  XDG_DATA_HOME="$WORK_DIR/home/data"
  XDG_STATE_HOME="$WORK_DIR/home/state"
  XDG_CACHE_HOME="$WORK_DIR/home/cache"
  NPM_CONFIG_CACHE="$WORK_DIR/npm-cache"
  NPM_CONFIG_USERCONFIG="$WORK_DIR/empty-npmrc"
)
(
  cd "$npm_smoke"
  "${packed_env[@]}" npm install \
    --ignore-scripts \
    --no-audit \
    --no-fund \
    --package-lock=false \
    --registry=https://registry.npmjs.org/ \
    "$OUT_DIR/$npm_archive"
)
installed_package="$npm_smoke/node_modules/mcporter"
for required_file in dist/cli.js dist/cli.d.ts dist/index.js dist/index.d.ts; do
  [[ -s "$installed_package/$required_file" ]] || {
    echo "isolated npm install is missing declared file: $required_file" >&2
    exit 1
  }
done
packed_version=$("${packed_env[@]}" node "$installed_package/dist/cli.js" --version)
[[ "$packed_version" == "$release_version" ]] || {
  echo "packed npm CLI version mismatch: $packed_version" >&2
  exit 1
}
PACKED_LIBRARY="$installed_package/dist/index.js" "${packed_env[@]}" node --input-type=module <<'NODE'
const { pathToFileURL } = await import('node:url');
const library = await import(pathToFileURL(process.env.PACKED_LIBRARY).href);
for (const name of ['callOnce', 'createRuntime', 'createServerProxy']) {
  if (typeof library[name] !== 'function') {
    throw new Error(`packed npm library export is missing: ${name}`);
  }
}
NODE

verify_native_archive() {
  local archive_name=$1 expected_arch=$2 stage binary listing signature embedded_requirement embedded host_arch output
  listing=$(tar -tzf "$OUT_DIR/$archive_name")
  [[ "$listing" == mcporter ]] || {
    echo "unexpected archive contents: $archive_name" >&2
    exit 1
  }
  stage="$WORK_DIR/$expected_arch"
  mkdir -p "$stage"
  tar -xzf "$OUT_DIR/$archive_name" -C "$stage"
  binary="$stage/mcporter"
  [[ -x "$binary" ]] || {
    echo "archive does not contain executable mcporter: $archive_name" >&2
    exit 1
  }
  [[ "$(lipo -archs "$binary")" == "$expected_arch" ]] || {
    echo "wrong Mach-O architecture: $archive_name" >&2
    exit 1
  }

  codesign --verify --strict -R="$REQUIREMENT" --verbose=2 "$binary"
  signature=$(codesign -dvvv "$binary" 2>&1)
  grep -Fx "Identifier=$IDENTIFIER" <<<"$signature" >/dev/null
  grep -Fx "Authority=$EXPECTED_AUTHORITY" <<<"$signature" >/dev/null
  grep -Fx "TeamIdentifier=$TEAM_ID" <<<"$signature" >/dev/null
  grep -E '^CodeDirectory .*flags=.*\(runtime\)' <<<"$signature" >/dev/null
  grep -E '^Timestamp=' <<<"$signature" >/dev/null
  embedded_requirement=$(codesign -d -r- "$binary" 2>&1)
  grep -Fqx "designated => $REQUIREMENT" <<<"$embedded_requirement" || {
    echo "embedded designated requirement mismatch: $archive_name" >&2
    exit 1
  }

  embedded="$stage/entitlements.plist"
  codesign -d --entitlements :- "$binary" >"$embedded" 2>/dev/null
  plutil -lint "$embedded" >/dev/null
  node - "$embedded" <<'NODE'
const { execFileSync } = require('node:child_process');
const entitlements = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', process.argv[2]], { encoding: 'utf8' }));
const expected = ['com.apple.security.cs.allow-jit', 'com.apple.security.cs.allow-unsigned-executable-memory'];
const actual = Object.keys(entitlements).sort();
if (JSON.stringify(actual) !== JSON.stringify(expected) || expected.some((key) => entitlements[key] !== true)) {
  throw new Error(`unexpected native entitlements: ${actual.join(', ')}`);
}
NODE

  codesign --verify --strict --check-notarization -R=notarized --verbose=2 "$binary"

  if [[ "$EXEC_ARCH" == all || "$EXEC_ARCH" == "$expected_arch" ]]; then
    host_arch=$(uname -m)
    if [[ "$host_arch" == "$expected_arch" ]]; then
      output=$("$binary" --version)
    elif [[ "$host_arch" == arm64 && "$expected_arch" == x86_64 ]]; then
      output=$(arch -x86_64 "$binary" --version)
    else
      echo "cannot execute $expected_arch candidate natively on $host_arch" >&2
      exit 1
    fi
    [[ "$output" == "$release_version" ]] || {
      echo "candidate version mismatch for $expected_arch: $output" >&2
      exit 1
    }
  fi
}

verify_native_archive "$arm_archive" arm64
verify_native_archive "$intel_archive" x86_64
echo "Verified $VERSION release assets from exact clean commit $head_commit"
