#!/usr/bin/env bash
set -euo pipefail

# Bun embeds a prebuilt runtime, so deployment environment alone is not proof.
minimums=$(otool -l "${1:?usage: check-macos-minimum.sh BINARY}" | awk '
  $1 == "cmd" { command = $2 }
  command == "LC_BUILD_VERSION" && $1 == "minos" { print $2 }
  command == "LC_VERSION_MIN_MACOSX" && $1 == "version" { print $2 }
')
[[ -n "$minimums" ]] || { echo 'Missing macOS deployment target' >&2; exit 1; }
while IFS= read -r minimum; do
  case "$minimum" in
    13.0|13.0.0) ;;
    *) echo "Expected macOS 13.0 deployment target, found $minimum" >&2; exit 1 ;;
  esac
done <<<"$minimums"
