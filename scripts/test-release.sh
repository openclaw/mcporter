#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
VERSION=$(node -p "require('$ROOT/package.json').version")
TAG="v$VERSION"
EXPECTED_IDENTITY='Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)'

fail() {
  echo "release contract test failed: $*" >&2
  exit 1
}

assert_fails() {
  local output
  output=$(mktemp "${TMPDIR:-/tmp}/mcporter-release-failure.XXXXXX")
  if "$@" >"$output" 2>&1; then
    cat "$output" >&2
    rm -f "$output"
    fail "command unexpectedly succeeded: $*"
  fi
  rm -f "$output"
}

for script in \
  "$ROOT/scripts/codesign-native.sh" \
  "$ROOT/scripts/package-release.sh" \
  "$ROOT/scripts/release.sh" \
  "$ROOT/scripts/verify-release.sh"; do
  bash -n "$script"
done
plutil -lint "$ROOT/scripts/macos-release.entitlements" >/dev/null

WORK=$(mktemp -d "${TMPDIR:-/tmp}/mcporter-release-contract.XXXXXX")
DIST_BACKUP="$WORK/original-dist"
DIST_EXISTED=0
if [[ -d "$ROOT/dist" ]]; then
  cp -R "$ROOT/dist" "$DIST_BACKUP"
  DIST_EXISTED=1
fi
cleanup() {
  rm -rf "$ROOT/dist"
  if [[ "$DIST_EXISTED" == 1 ]]; then
    cp -R "$DIST_BACKUP" "$ROOT/dist"
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT
MOCK_BIN="$WORK/bin"
MOCK_LOG="$WORK/mock.log"
mkdir -p "$MOCK_BIN"
: >"$MOCK_LOG"
export MCPORTER_TEST_ROOT="$ROOT" MOCK_LOG

cat >"$MOCK_BIN/uname" <<'MOCK'
#!/usr/bin/env bash
case "${1:-}" in
  -s) echo Darwin ;;
  -m) echo arm64 ;;
  *) echo Darwin ;;
esac
MOCK

cat >"$MOCK_BIN/git" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
args=("$@")
while [[ ${#args[@]} -gt 0 ]]; do
  case "${args[0]}" in
    -C|-c) args=("${args[@]:2}") ;;
    *) break ;;
  esac
done
case "${args[*]}" in
  'rev-parse HEAD') echo 0123456789abcdef0123456789abcdef01234567 ;;
  'rev-parse refs/tags/'*'^'{commit'}')
    echo "${MOCK_TAG_COMMIT:-0123456789abcdef0123456789abcdef01234567}"
    ;;
  'status --porcelain --untracked-files=normal')
    [[ "${MOCK_GIT_DIRTY:-0}" == 0 ]] || echo ' M package.json'
    ;;
  'tag -v '* ) [[ "${MOCK_TAG_VERIFY_FAIL:-0}" == 0 ]] ;;
  *) echo "unexpected mock git arguments: ${args[*]}" >&2; exit 64 ;;
esac
MOCK

cat >"$MOCK_BIN/bun" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == --version ]]; then
  echo 1.3.14
  exit 0
fi
output=
while [[ $# -gt 0 ]]; do
  if [[ "$1" == --output ]]; then
    output=$2
    shift 2
  else
    shift
  fi
done
[[ -n "$output" ]]
mkdir -p "$(dirname "$output")"
cat >"$output" <<EOF
#!/usr/bin/env bash
[[ "\${1:-}" == --version ]] && echo "$(node -p "require('$MCPORTER_TEST_ROOT/package.json').version")"
EOF
chmod 755 "$output"
MOCK

cat >"$MOCK_BIN/pnpm" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == --version ]]; then
  echo 10.33.2
  exit 0
fi
if [[ "${1:-}" == clean ]]; then
  rm -rf "$MCPORTER_TEST_ROOT/dist"
  exit 0
fi
if [[ "${1:-}" == build ]]; then
  version=$(node -p "require('$MCPORTER_TEST_ROOT/package.json').version")
  mkdir -p "$MCPORTER_TEST_ROOT/dist"
  cat >"$MCPORTER_TEST_ROOT/dist/cli.js" <<EOF
#!/usr/bin/env node
if (process.argv[2] === '--version') console.log('$version');
EOF
  chmod 755 "$MCPORTER_TEST_ROOT/dist/cli.js"
  cat >"$MCPORTER_TEST_ROOT/dist/index.js" <<'EOF'
export function callOnce() {}
export function createRuntime() {}
export function createServerProxy() {}
EOF
  printf 'export declare function main(): void;\n' >"$MCPORTER_TEST_ROOT/dist/cli.d.ts"
  printf 'export declare function createRuntime(): void;\n' >"$MCPORTER_TEST_ROOT/dist/index.d.ts"
  exit 0
fi
[[ "${1:-}" == pack ]]
destination=
while [[ $# -gt 0 ]]; do
  if [[ "$1" == --pack-destination ]]; then
    destination=$2
    shift 2
  else
    shift
  fi
done
[[ -n "$destination" ]]
version=$(node -p "require('$MCPORTER_TEST_ROOT/package.json').version")
stage=$(mktemp -d "${TMPDIR:-/tmp}/mcporter-mock-pack.XXXXXX")
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/package"
cp "$MCPORTER_TEST_ROOT/package.json" "$stage/package/package.json"
cp "$MCPORTER_TEST_ROOT/README.md" "$MCPORTER_TEST_ROOT/LICENSE" "$stage/package/"
cp -R "$MCPORTER_TEST_ROOT/dist" "$stage/package/dist"
tar -czf "$destination/mcporter-$version.tgz" -C "$stage" package
MOCK

cat >"$MOCK_BIN/npm" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
[[ "${1:-}" == install ]]
archive=${!#}
stage=$(mktemp -d "${TMPDIR:-/tmp}/mcporter-mock-install.XXXXXX")
trap 'rm -rf "$stage"' EXIT
tar -xzf "$archive" -C "$stage"
mkdir -p node_modules/mcporter
cp -R "$stage/package/." node_modules/mcporter/
MOCK

cat >"$MOCK_BIN/codesign" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *' --sign '* ]]; then
  printf 'sign %s\n' "${!#}" >>"$MOCK_LOG"
  exit 0
fi
if [[ "${1:-}" == --verify ]]; then
  if [[ " $* " == *' --check-notarization '* ]]; then
    printf 'notarization-check %s\n' "${!#}" >>"$MOCK_LOG"
    [[ "${MOCK_NOTARIZATION_READY:-1}" == 1 ]]
  fi
  exit
fi
if [[ "${1:-}" == -dvvv ]]; then
  cat >&2 <<'EOF'
Identifier=org.openclaw.mcporter
CodeDirectory v=20500 size=123 flags=0x10000(runtime) hashes=1+7 location=embedded
Authority=Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)
TeamIdentifier=FWJYW4S8P8
Timestamp=09 Jul 2026 at 12:00:00
EOF
  exit 0
fi
if [[ "${1:-}" == -d && " $* " == *' --entitlements :- '* ]]; then
  cat <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>com.apple.security.cs.allow-jit</key><true/>
<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
</dict></plist>
EOF
  exit 0
fi
if [[ "${1:-}" == -d && " $* " == *' -r- '* ]]; then
  cat >&2 <<'EOF'
Executable=/mock/mcporter
designated => identifier "org.openclaw.mcporter" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "FWJYW4S8P8"
EOF
  exit 0
fi
echo "unexpected mock codesign arguments: $*" >&2
exit 64
MOCK

cat >"$MOCK_BIN/ditto" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
: >"${!#}"
MOCK

cat >"$MOCK_BIN/xcrun" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf 'notary-submit\n' >>"$MOCK_LOG"
printf '{"id":"mock-submission","status":"%s"}\n' "${MOCK_NOTARY_STATUS:-Accepted}"
MOCK

cat >"$MOCK_BIN/lipo" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
case "${!#}" in
  *x86_64*) echo x86_64 ;;
  *) echo arm64 ;;
esac
MOCK

cat >"$MOCK_BIN/arch" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
[[ "${1:-}" == -x86_64 ]] && shift
exec "$@"
MOCK

chmod 755 "$MOCK_BIN"/*
export PATH="$MOCK_BIN:$PATH"

# Ordinary builds never enter signing or notarization code.
MCPORTER_OFFICIAL_RELEASE=0 "$ROOT/scripts/codesign-native.sh" "$WORK/missing"
[[ ! -s "$MOCK_LOG" ]] || fail 'ordinary build invoked release tools'

plain_binary="$WORK/mcporter"
printf '#!/usr/bin/env bash\necho %s\n' "$VERSION" >"$plain_binary"
chmod 755 "$plain_binary"
assert_fails env \
  MCPORTER_OFFICIAL_RELEASE=1 \
  CODESIGN_IDENTITY="$EXPECTED_IDENTITY" \
  "$ROOT/scripts/codesign-native.sh" "$plain_binary"
[[ ! -s "$MOCK_LOG" ]] || fail 'missing notary profile reached release tools'
assert_fails env \
  MCPORTER_OFFICIAL_RELEASE=1 \
  CODESIGN_IDENTITY='Developer ID Application: Wrong Team (AAAAAAAAAA)' \
  NOTARYTOOL_KEYCHAIN_PROFILE=mock-profile \
  "$ROOT/scripts/codesign-native.sh" "$plain_binary"
[[ ! -s "$MOCK_LOG" ]] || fail 'wrong signing identity reached release tools'

MCPORTER_OFFICIAL_RELEASE=1 \
  CODESIGN_IDENTITY="$EXPECTED_IDENTITY" \
  NOTARYTOOL_KEYCHAIN_PROFILE=mock-profile \
  "$ROOT/scripts/codesign-native.sh" "$plain_binary"
[[ "$(grep -c '^sign ' "$MOCK_LOG")" == 1 ]] || fail 'mock signing count mismatch'
[[ "$(grep -c '^notary-submit$' "$MOCK_LOG")" == 1 ]] || fail 'mock notary count mismatch'
[[ "$(grep -c '^notarization-check ' "$MOCK_LOG")" == 1 ]] || fail 'online notarization check count mismatch'

# A dirty source tree and a rejected notarization both fail before output is published.
: >"$MOCK_LOG"
dirty_out="$WORK/dirty-output"
assert_fails env \
  MCP_RUNNER=env \
  MCPORTER_RELEASE_OUT_DIR="$dirty_out" \
  MAC_RELEASE_CODESIGN_IDENTITY="$EXPECTED_IDENTITY" \
  NOTARYTOOL_KEYCHAIN_PROFILE=mock-profile \
  MOCK_GIT_DIRTY=1 \
  "$ROOT/scripts/package-release.sh" "$TAG"
[[ ! -e "$dirty_out" && ! -s "$MOCK_LOG" ]] || fail 'dirty tree produced or signed release output'

rejected_out="$WORK/rejected-output"
assert_fails env \
  MCP_RUNNER=env \
  MCPORTER_RELEASE_OUT_DIR="$rejected_out" \
  MAC_RELEASE_CODESIGN_IDENTITY="$EXPECTED_IDENTITY" \
  NOTARYTOOL_KEYCHAIN_PROFILE=mock-profile \
  MOCK_NOTARY_STATUS=Rejected \
  "$ROOT/scripts/package-release.sh" "$TAG"
[[ ! -e "$rejected_out" ]] || fail 'rejected notarization published release output'

# The happy path exercises dual builds, signing/notary calls, packaging, provenance,
# basename-only checksums, and the token-free exact-inventory verifier.
: >"$MOCK_LOG"
release_out="$WORK/release-output"
MCP_RUNNER=env \
  MCPORTER_RELEASE_OUT_DIR="$release_out" \
  MAC_RELEASE_CODESIGN_IDENTITY="$EXPECTED_IDENTITY" \
  NOTARYTOOL_KEYCHAIN_PROFILE=mock-profile \
  "$ROOT/scripts/package-release.sh" "$TAG"
[[ "$(grep -c '^sign ' "$MOCK_LOG")" == 2 ]] || fail 'dual-architecture signing count mismatch'
[[ "$(grep -c '^notary-submit$' "$MOCK_LOG")" == 2 ]] || fail 'dual-architecture notarization count mismatch'

expected_inventory=$(printf '%s\n' \
  "mcporter_${VERSION}_darwin_arm64.tar.gz" \
  "mcporter_${VERSION}_darwin_x86_64.tar.gz" \
  "mcporter-${VERSION}.tgz" \
  checksums.txt \
  provenance.json | LC_ALL=C sort)
actual_inventory=$(find "$release_out" -mindepth 1 -maxdepth 1 -exec basename {} \; | LC_ALL=C sort)
[[ "$actual_inventory" == "$expected_inventory" ]] || fail 'release output inventory mismatch'
awk 'NF != 2 || $2 ~ /\// { exit 1 }' "$release_out/checksums.txt" || fail 'checksum contains a path'

touch "$release_out/unexpected.txt"
assert_fails env -u GH_TOKEN -u GITHUB_TOKEN \
  MCPORTER_VERIFY_EXEC_ARCH=all \
  "$ROOT/scripts/verify-release.sh" "$TAG" "$release_out"
rm "$release_out/unexpected.txt"
assert_fails env GH_TOKEN=x \
  MCPORTER_VERIFY_EXEC_ARCH=all \
  "$ROOT/scripts/verify-release.sh" "$TAG" "$release_out"

cp "$release_out/checksums.txt" "$WORK/checksums.txt"
awk 'NR == 1 { $2 = "dist-bun/" $2 } { print $1 "  " $2 }' \
  "$WORK/checksums.txt" >"$release_out/checksums.txt"
assert_fails env -u GH_TOKEN -u GITHUB_TOKEN \
  MCPORTER_VERIFY_EXEC_ARCH=all \
  "$ROOT/scripts/verify-release.sh" "$TAG" "$release_out"
cp "$WORK/checksums.txt" "$release_out/checksums.txt"

# A package.json-only tarball cannot pass even when its provenance and
# checksums are internally self-consistent.
package_only_out="$WORK/package-only-output"
cp -R "$release_out" "$package_only_out"
package_only_stage="$WORK/package-only-stage"
mkdir -p "$package_only_stage/package"
cp "$ROOT/package.json" "$package_only_stage/package/package.json"
tar -czf "$package_only_out/mcporter-${VERSION}.tgz" -C "$package_only_stage" package/package.json
PACKAGE_ONLY_OUT="$package_only_out" VERSION="$VERSION" node <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.PACKAGE_ONLY_OUT;
const npmName = `mcporter-${process.env.VERSION}.tgz`;
const sha256 = (name) => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex');
const provenancePath = path.join(root, 'provenance.json');
const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
provenance.payloads.find((payload) => payload.name === npmName).sha256 = sha256(npmName);
fs.writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
const names = [
  `mcporter_${process.env.VERSION}_darwin_arm64.tar.gz`,
  `mcporter_${process.env.VERSION}_darwin_x86_64.tar.gz`,
  npmName,
  'provenance.json',
];
fs.writeFileSync(
  path.join(root, 'checksums.txt'),
  `${names.map((name) => `${sha256(name)}  ${name}`).join('\n')}\n`
);
NODE
assert_fails env -u GH_TOKEN -u GITHUB_TOKEN \
  MCPORTER_VERIFY_EXEC_ARCH=all \
  "$ROOT/scripts/verify-release.sh" "$TAG" "$package_only_out"

# Workflow and orchestration boundaries: protected current default branch,
# exact REST draft inventory, narrow token scope, and no one-shot publish path.
release_workflow="$ROOT/.github/workflows/release-assets.yml"
homebrew_workflow="$ROOT/.github/workflows/update-homebrew-tap.yml"
assert_fails "$ROOT/scripts/package-release.sh" v1.2.3-rc.1
assert_fails "$ROOT/scripts/verify-release.sh" v1.2.3-rc.1 "$WORK/missing-prerelease-assets"
grep -Fq '[[ "$RELEASE_TAG" =~ ^v[0-9]+[.][0-9]+[.][0-9]+$ ]]' "$release_workflow"
grep -Fq '[[ "$RELEASE_TAG" =~ ^v[0-9]+[.][0-9]+[.][0-9]+$ ]]' "$homebrew_workflow"
grep -Eq 'GITHUB_REF.*expected_ref' "$release_workflow"
grep -Eq 'GITHUB_WORKFLOW_REF.*expected_workflow_ref' "$release_workflow"
grep -Eq 'github.workflow_sha' "$release_workflow"
grep -Eq 'persist-credentials: false' "$release_workflow"
grep -Eq '^    permissions:$' "$release_workflow"
grep -Eq '^      contents: write$' "$release_workflow"
grep -Fq 'GH_TOKEN: ${{ github.token }}' "$release_workflow"
! grep -Eq 'pnpm install' "$release_workflow" || fail 'draft verifier borrows checkout dependencies'
grep -Eq 'releases\?per_page=100' "$release_workflow"
grep -Eq 'draft == true' "$release_workflow"
grep -Eq 'releases/assets/\$asset_id' "$release_workflow"
grep -Eq 'env -u GH_TOKEN -u GITHUB_TOKEN' "$release_workflow"
grep -Eq 'verified-assets.json' "$release_workflow"
grep -Eq 'actions/upload-artifact@' "$release_workflow"
grep -Eq 'schemaVersion: 2' "$release_workflow"
grep -Eq 'arch: process.env.RELEASE_ARCH' "$release_workflow"
[[ "$(grep -Ec '^          GH_TOKEN:' "$release_workflow")" == 1 ]] || fail 'release token scope changed'
! grep -Eq 'secrets\.RELEASE_ASSET_TOKEN' "$release_workflow" || fail 'release verifier uses a persistent secret'
! grep -Eq 'gh release download' "$release_workflow" || fail 'release download bypasses exact REST lookup'

! grep -Eq '\bspctl\b' "$ROOT/scripts/codesign-native.sh" "$ROOT/scripts/verify-release.sh" || \
  fail 'standalone CLI verification must not require raw-binary spctl success'
grep -Eq -- '--requirements "=designated => \$REQUIREMENT"' "$ROOT/scripts/codesign-native.sh"
for native_script in "$ROOT/scripts/codesign-native.sh" "$ROOT/scripts/verify-release.sh"; do
  grep -Eq -- '--verify --strict --check-notarization -R=notarized' "$native_script" || \
    fail 'standalone CLI online notarization constraint changed'
done

grep -Eq 'GITHUB_REF.*expected_ref' "$homebrew_workflow"
grep -Eq 'GITHUB_WORKFLOW_REF.*expected_workflow_ref' "$homebrew_workflow"
! grep -Eq '^  release:' "$homebrew_workflow" || fail 'Homebrew workflow regained automatic release trigger'
[[ "$(grep -Ec '^          GH_TOKEN:' "$homebrew_workflow")" == 2 ]] || fail 'Homebrew token scope changed'
grep -Eq 'native_verifier_run_id' "$homebrew_workflow"
grep -Eq 'gh run download' "$homebrew_workflow"
grep -Eq 'verified-assets-arm64' "$homebrew_workflow"
grep -Eq 'verified-assets-x86_64' "$homebrew_workflow"
grep -Eq 'native proof artifacts disagree on the verified asset set' "$homebrew_workflow"
grep -Eq 'published asset digest changed after native verification' "$homebrew_workflow"
grep -Eq 'npm registry integrity does not match the verified GitHub tarball' "$homebrew_workflow"
grep -Eq 'codesign-run --' "$ROOT/scripts/release.sh"
grep -Eq 'command -v mac-release' "$ROOT/scripts/release.sh"
grep -Eq 'MAC_RELEASE_HELPER' "$ROOT/scripts/release.sh"
grep -Eq 'gh run download' "$ROOT/scripts/release.sh"
grep -Eq 'verified-assets-arm64' "$ROOT/scripts/release.sh"
grep -Eq 'verified-assets-x86_64' "$ROOT/scripts/release.sh"
grep -Eq 'native proof artifacts disagree on the verified asset set' "$ROOT/scripts/release.sh"
grep -Eq 'immutable registry metadata' "$ROOT/scripts/release.sh"
grep -Eq 'registry did not expose the verified release artifact before timeout' "$ROOT/scripts/release.sh"
! grep -Eq '^  all|git push|git tag ' "$ROOT/scripts/release.sh" || fail 'release helper regained combined/tag/push path'
grep -Eq 'pnpm clean' "$ROOT/scripts/package-release.sh"
grep -Eq 'pnpm build' "$ROOT/scripts/package-release.sh"
grep -Eq 'NPM_CONFIG_IGNORE_SCRIPTS=true.*pnpm pack' "$ROOT/scripts/package-release.sh"
grep -Eq 'NPM_CONFIG_IGNORE_SCRIPTS=true.*pnpm publish.*\$npm_archive' "$ROOT/scripts/release.sh"
grep -Eq 'packed npm CLI version mismatch' "$ROOT/scripts/verify-release.sh"
grep -Eq 'packed npm library export is missing' "$ROOT/scripts/verify-release.sh"
grep -Eq 'npm install' "$ROOT/scripts/verify-release.sh"
! grep -Eq 'ROOT/node_modules|ln -s.*node_modules' "$ROOT/scripts/verify-release.sh" || \
  fail 'npm verifier borrows checkout dependencies'

echo "Release contract tests passed for $TAG"
