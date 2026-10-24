#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
target=${1:?usage: smoke-native.sh TARGET ARCH OUTPUT_DIRECTORY}
build_arch=${2:?missing architecture}
output=${3:?missing output directory}
case "$target:$build_arch" in
  bun-darwin-arm64:arm64) ;;
  bun-darwin-x64-baseline:x86_64) "$ROOT/scripts/ensure-rosetta.sh" ;;
  *) echo 'Unsupported native target/architecture pair' >&2; exit 1 ;;
esac

export MACOSX_DEPLOYMENT_TARGET=13.0
stage="$output/native-$build_arch"
smoke="$output/smoke-$build_arch"
mkdir -p "$stage" "$smoke/home"
binary="$stage/mcporter"
cd "$ROOT"
pnpm build:bun --target "$target" --output "$binary"
[[ "$(lipo -archs "$binary")" == "$build_arch" ]]
"$ROOT/scripts/check-macos-minimum.sh" "$binary"
# Bun's x64 baseline output can retain an invalid upstream signature.
codesign --force --sign - --identifier org.openclaw.mcporter.dry-run "$binary"
codesign --verify --strict --verbose=2 "$binary"
archive="$output/mcporter-dry-run-$build_arch.tar.gz"
tar -czf "$archive" -C "$stage" mcporter
[[ "$(tar -tzf "$archive")" == mcporter ]]
tar -xzf "$archive" -C "$smoke"
version=$(node -p 'require("./package.json").version')
cd "$smoke"
export HOME="$smoke/home"
printf '{"mcpServers":{}}\n' >"$smoke/empty.json"
if [[ "$build_arch" == x86_64 ]]; then
  runtime=$(BUN_BE_BUN=1 /usr/bin/arch -x86_64 ./mcporter --print 'process.versions.bun')
  [[ "$runtime" == "$(bun --version)" ]]
  echo "Embedded Bun ($build_arch): $runtime"
  [[ "$(/usr/bin/arch -x86_64 ./mcporter --version)" == "$version" ]]
  /usr/bin/arch -x86_64 ./mcporter --help
  /usr/bin/arch -x86_64 ./mcporter --config "$smoke/empty.json" list --json
else
  runtime=$(BUN_BE_BUN=1 ./mcporter --print 'process.versions.bun')
  [[ "$runtime" == "$(bun --version)" ]]
  echo "Embedded Bun ($build_arch): $runtime"
  [[ "$(./mcporter --version)" == "$version" ]]
  ./mcporter --help
  ./mcporter --config "$smoke/empty.json" list --json
fi
