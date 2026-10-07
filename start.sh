#!/bin/bash
set -e

echo "[start] booting X server..."
Xvfb :99 -screen 0 ${SCREEN_WIDTH}x${SCREEN_HEIGHT}x${SCREEN_DEPTH} -ac +extension GLX +render -noreset &
XVFB_PID=$!
sleep 1

export DISPLAY=:99

echo "[start] booting window manager..."
openbox-session &
sleep 1

echo "[start] booting x11vnc..."
mkdir -p /root/.vnc
x11vnc -display :99 -nopw -forever -shared -rfbport 5900 -xkb -noxrecord -noxfixes -noxdamage &
sleep 1

echo "[start] booting noVNC + websockify on :6080..."
websockify --web /usr/share/novnc 6080 localhost:5900 &
sleep 1

echo "[start] launching chrome kiosk on IXL..."
# launch a real chromium binary (playwright's) in kiosk mode, not headless
CHROME_BIN=$(find /ms-playwright -name chrome -type f 2>/dev/null | head -n 1 || find /root/.cache/ms-playwright -name chrome -type f 2>/dev/null | head -n 1 || echo "")
if [ -z "$CHROME_BIN" ]; then
  echo "[start] chrome not found, falling back to chromium-browser"
  CHROME_BIN=chromium
fi
echo "[start] chrome path: $CHROME_BIN"
"$CHROME_BIN" \
  --no-sandbox \
  --disable-setuid-sandbox \
  --disable-dev-shm-usage \
  --disable-blink-features=AutomationControlled \
  --start-maximized \
  --window-position=0,0 \
  --window-size=${SCREEN_WIDTH},${SCREEN_HEIGHT} \
  --user-data-dir=/tmp/ixl-profile \
  --no-first-run \
  --no-default-browser-check \
  --disable-features=IsolateOrigins,site-per-process \
  https://www.ixl.com/ &

echo "[start] launching node server on :3000..."
node server.js