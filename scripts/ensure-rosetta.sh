#!/usr/bin/env bash
set -euo pipefail

if ! /usr/bin/arch -x86_64 /usr/bin/true; then
  sudo /usr/sbin/softwareupdate --install-rosetta --agree-to-license
fi
/usr/bin/arch -x86_64 /usr/bin/true
