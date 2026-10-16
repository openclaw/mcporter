#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/mcporter-package-test.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
cd "$ROOT"
NPM_CONFIG_IGNORE_SCRIPTS=true pnpm pack --pack-destination "$WORK"
version=$(node -p "require('./package.json').version")
mkdir -p "$WORK/consumer" "$WORK/home"
printf '{"private":true}\n' >"$WORK/consumer/package.json"
: >"$WORK/empty-npmrc"
(
  cd "$WORK/consumer"
  HOME="$WORK/home" NPM_CONFIG_USERCONFIG="$WORK/empty-npmrc" \
    npm install --ignore-scripts --no-audit --no-fund --package-lock=false \
    --registry=https://registry.npmjs.org/ "$WORK/mcporter-$version.tgz"
)
(
  cd "$WORK/consumer"
  export HOME="$WORK/home" NPM_CONFIG_USERCONFIG="$WORK/empty-npmrc"
  [[ "$(node node_modules/mcporter/dist/cli.js --version)" == "$version" ]]
  node node_modules/mcporter/dist/cli.js --help >/dev/null
  node --input-type=module <<'NODE'
import * as library from 'mcporter';
for (const name of ['callOnce', 'createRuntime', 'createServerProxy']) {
  if (typeof library[name] !== 'function') throw new Error(`Missing public export: ${name}`);
}
NODE
)
node "$ROOT/scripts/verify-packaged-oauth.mjs" "$WORK/consumer/node_modules/mcporter"
