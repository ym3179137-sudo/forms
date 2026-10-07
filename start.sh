#!/bin/bash
set -e

echo "[start] booting Xvfb..."
Xvfb :99 -screen 0 1366x768x24 -ac +extension GLX +render -noreset &
export DISPLAY=:99
sleep 2

echo "[start] booting x11vnc..."
mkdir -p /root/.vnc
x11vnc -display :99 -nopw -forever -shared -rfbport 5900 -xkb -noxrecord -noxfixes -noxdamage &
sleep 2

echo "[start] booting websockify on :6080..."
websockify --web /usr/share/novnc 6080 localhost:5900 &
sleep 2

echo "[start] locating chromium binary..."
CHROME_BIN=""
for p in \
  /ms-playwright/chromium-*/chrome-linux/chrome \
  /root/.cache/ms-playwright/chromium-*/chrome-linux/chrome \
  /usr/bin/chromium \
  /usr/bin/chromium-browser \
  /usr/bin/google-chrome ; do
  if ls $p >/dev/null 2>&1; then
    CHROME_BIN=$(ls $p 2>/dev/null | head -1)
    break
  fi
done

if [ -z "$CHROME_BIN" ]; then
  echo "[start] FATAL: no chromium binary found"
  ls -la /ms-playwright 2>/dev/null || true
  ls -la /root/.cache/ms-playwright 2>/dev/null || true
else
  echo "[start] chromium: $CHROME_BIN"
  echo "[start] launching chromium on IXL..."
  "$CHROME_BIN" \
    --no-sandbox \
    --disable-setuid-sandbox \
    --disable-dev-shm-usage \
    --disable-blink-features=AutomationControlled \
    --disable-gpu \
    --window-position=0,0 \
    --window-size=1366,768 \
    --kiosk \
    --user-data-dir=/tmp/ixl-profile \
    --no-first-run \
    --no-default-browser-check \
    --disable-features=IsolateOrigins,site-per-process \
    --disable-infobars \
    --disable-translate \
    --disable-session-crashed-bubble \
    --disable-restore-session-state \
    https://www.ixl.com/ > /tmp/chrome.log 2>&1 &

  echo "[start] chrome pid: $!"
fi

echo "[start] launching node server..."
node server.js