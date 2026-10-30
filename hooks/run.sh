#!/usr/bin/env bash
# Runs a gatecheck hook. Never blocks Claude because of gatecheck's own setup:
# a missing Node, an old Node or a failed install exits 0.
set -u
root="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
event="${1:-}"

command -v node >/dev/null 2>&1 || exit 0
major=$(node -p 'process.versions.node.split(".").map(Number).reduce((a, n, i) => i === 0 ? n : i === 1 ? a * 1000 + n : a)' 2>/dev/null || echo 0)
# Node 23.6+ runs gatecheck's TypeScript directly.
[ "$major" -ge 23006 ] 2>/dev/null || exit 0

if [ ! -d "$root/node_modules/web-tree-sitter" ]; then
  npm ci --prefix "$root" --omit=dev --no-audit --no-fund --loglevel=error >/dev/null 2>&1 || exit 0
fi
[ "$event" = setup ] && exit 0

exec node "$root/packages/cli/src/main.ts" hook "$event"
