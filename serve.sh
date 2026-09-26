#!/usr/bin/env bash
# Launch VOID RUNNER with a local static server.
#
# ES modules will not load over file://, so a server is required.
# The game itself needs no build step — Three.js is vendored in ./vendor.

set -euo pipefail
cd "$(dirname "$0")"

PORT="${1:-8080}"

echo ""
echo "  VOID RUNNER"
echo "  ─────────────────────────────────────────"
echo "  Serving on http://localhost:${PORT}"
echo "  Press Ctrl+C to stop."
echo ""

# Prefer the project's own dev server: it sends `Cache-Control: no-store`, so
# a reload always picks up the current tree. Plain `python3 -m http.server`
# sends no cache headers, which lets the browser hold a mix of old and new ES
# modules — a new weapons.js running against a stale config.js is a genuinely
# baffling failure to debug.
if command -v python3 >/dev/null 2>&1 && [ -f tools/serve.py ]; then
  exec python3 tools/serve.py "$PORT"
fi

# Pick whichever server is available.
if command -v python3 >/dev/null 2>&1; then
  exec python3 -m http.server "$PORT"
elif command -v python >/dev/null 2>&1; then
  exec python -m http.server "$PORT"
elif command -v npx >/dev/null 2>&1; then
  exec npx --yes serve -l "$PORT" .
elif command -v php >/dev/null 2>&1; then
  exec php -S "localhost:${PORT}"
else
  echo "No server found. Install Python 3, or serve this directory with any static server." >&2
  exit 1
fi
