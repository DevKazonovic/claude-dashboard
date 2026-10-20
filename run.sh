#!/usr/bin/env sh
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "claude-dashboard needs Node.js 18 or newer. Install it from https://nodejs.org, then run ./run.sh again."
  exit 1
fi

major="$(node -p "parseInt(process.versions.node)")"
if [ "$major" -lt 18 ]; then
  echo "claude-dashboard needs Node.js 18 or newer, and this computer has $(node -v). Update it from https://nodejs.org, then run ./run.sh again."
  exit 1
fi

exec node bin/claude-dashboard.js "$@"
