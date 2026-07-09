#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
BINARY=${1:-}
OFFICIAL_RELEASE=${MCPORTER_OFFICIAL_RELEASE:-0}
IDENTIFIER=org.openclaw.mcporter
TEAM_ID=FWJYW4S8P8
EXPECTED_AUTHORITY="Developer ID Application: OpenClaw Foundation ($TEAM_ID)"
CODESIGN_IDENTITY=${CODESIGN_IDENTITY:-${MAC_RELEASE_CODESIGN_IDENTITY:-}}
ENTITLEMENTS="$ROOT/scripts/macos-release.entitlements"
REQUIREMENT="identifier \"$IDENTIFIER\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"$TEAM_ID\""

[[ "$OFFICIAL_RELEASE" == 0 || "$OFFICIAL_RELEASE" == 1 ]] || {
  echo "MCPORTER_OFFICIAL_RELEASE must be 0 or 1" >&2
  exit 2
}
[[ "$OFFICIAL_RELEASE" == 1 ]] || exit 0
[[ -f "$BINARY" ]] || {
  echo "usage: MCPORTER_OFFICIAL_RELEASE=1 $0 /path/to/mcporter" >&2
  exit 2
}
[[ "$(uname -s)" == Darwin ]] || {
  echo "official macOS release signing must run on macOS" >&2
  exit 1
}
[[ "${CODESIGN_IDENTITY:-}" == "$EXPECTED_AUTHORITY" ]] || {
  echo "official macOS releases require $EXPECTED_AUTHORITY" >&2
  exit 1
}
[[ -n "${NOTARYTOOL_KEYCHAIN_PROFILE:-}" ]] || {
  echo "NOTARYTOOL_KEYCHAIN_PROFILE is required for official macOS releases" >&2
  exit 1
}

for tool in codesign ditto node plutil xcrun; do
  command -v "$tool" >/dev/null || {
    echo "missing required tool: $tool" >&2
    exit 1
  }
done
plutil -lint "$ENTITLEMENTS" >/dev/null

WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/mcporter-notary.XXXXXX")
trap 'rm -rf "$WORK_DIR"' EXIT
NOTARY_ARCHIVE="$WORK_DIR/$(basename "$BINARY").zip"
NOTARY_RESULT="$WORK_DIR/notary-result.json"
EMBEDDED_ENTITLEMENTS="$WORK_DIR/embedded-entitlements.plist"

codesign \
  --force \
  --options runtime \
  --timestamp \
  --identifier "$IDENTIFIER" \
  --requirements "=designated => $REQUIREMENT" \
  --entitlements "$ENTITLEMENTS" \
  --sign "$CODESIGN_IDENTITY" \
  "$BINARY"

codesign --verify --strict -R="$REQUIREMENT" --verbose=2 "$BINARY"
signature=$(codesign -dvvv "$BINARY" 2>&1)
grep -Fx "Identifier=$IDENTIFIER" <<<"$signature" >/dev/null
grep -Fx "Authority=$EXPECTED_AUTHORITY" <<<"$signature" >/dev/null
grep -Fx "TeamIdentifier=$TEAM_ID" <<<"$signature" >/dev/null
grep -E '^CodeDirectory .*flags=.*\(runtime\)' <<<"$signature" >/dev/null
grep -E '^Timestamp=' <<<"$signature" >/dev/null
embedded_requirement=$(codesign -d -r- "$BINARY" 2>&1)
grep -Fqx "designated => $REQUIREMENT" <<<"$embedded_requirement" || {
  echo "embedded designated requirement does not match the release policy" >&2
  exit 1
}

codesign -d --entitlements :- "$BINARY" >"$EMBEDDED_ENTITLEMENTS" 2>/dev/null
plutil -lint "$EMBEDDED_ENTITLEMENTS" >/dev/null
node - "$EMBEDDED_ENTITLEMENTS" <<'NODE'
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const file = process.argv[2];
const json = execFileSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' });
const entitlements = JSON.parse(json);
const expected = [
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory',
];
const actual = Object.keys(entitlements).sort();
if (JSON.stringify(actual) !== JSON.stringify(expected) || expected.some((key) => entitlements[key] !== true)) {
  throw new Error(`unexpected embedded entitlements: ${actual.join(', ')}`);
}
NODE

ditto -c -k --keepParent "$BINARY" "$NOTARY_ARCHIVE"
xcrun notarytool submit "$NOTARY_ARCHIVE" \
  --keychain-profile "$NOTARYTOOL_KEYCHAIN_PROFILE" \
  --no-s3-acceleration \
  --wait \
  --output-format json >"$NOTARY_RESULT"
node - "$NOTARY_RESULT" <<'NODE'
const fs = require('node:fs');
const result = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (result.status !== 'Accepted') {
  throw new Error(`notarization failed: ${result.status ?? 'unknown status'}`);
}
console.log(`Notarization accepted: ${result.id ?? 'submission id unavailable'}`);
NODE

notarization_ready=0
for _ in {1..12}; do
  if codesign --verify --strict --check-notarization -R=notarized --verbose=2 "$BINARY"; then
    notarization_ready=1
    break
  fi
  sleep 5
done
[[ "$notarization_ready" == 1 ]] || {
  echo "accepted notarization ticket did not become available online" >&2
  exit 1
}
