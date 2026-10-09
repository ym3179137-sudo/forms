#!/bin/bash
set +e

echo "[start] cleaning stale X locks..."
rm -f /tmp/.X*-lock 2>/dev/null
rm -rf /tmp/.X11-unix/X* 2>/dev/null

mkdir -p /data/profiles

echo "[start] browser binaries:"
for b in google-chrome-stable brave-browser microsoft-edge-stable firefox-esr; do
  p=$(which $b 2>/dev/null)
  echo "  $b: ${p:-MISSING}"
done

echo "[start] launching node server..."
exec node server.js