#!/bin/bash
set +e

echo "[start] booting Xvfb..."
Xvfb :99 -screen 0 1280x720x24 -ac +extension GLX +render -noreset -nolisten tcp &
export DISPLAY=:99
sleep 1

echo "[start] booting x11vnc..."
x11vnc -display :99 -nopw -forever -shared -rfbport 5900 -xkb -noxrecord -noxfixes -noxdamage -wait 5 -defer 5 -nopw -threads -ping 5 &
sleep 1

echo "[start] booting websockify on :6080..."
websockify --web /usr/share/novnc 6080 localhost:5900 &
sleep 1

echo "[start] locating chromium binary..."
CHROME_BIN=$(find /ms-playwright -type f -name chrome 2>/dev/null | head -1)

if [ -z "$CHROME_BIN" ]; then
  echo "[start] FATAL: no chromium binary found"
  node server.js
  exit 0
fi

echo "[start] chromium: $CHROME_BIN"
chmod +x "$CHROME_BIN" 2>/dev/null

# launch chromium straight to IXL sign-in page
"$CHROME_BIN" \
  --no-sandbox \
  --disable-setuid-sandbox \
  --disable-dev-shm-usage \
  --disable-blink-features=AutomationControlled \
  --disable-gpu \
  --disable-software-rasterizer \
  --disable-background-networking \
  --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --disable-features=IsolateOrigins,site-per-process,Translate,BackForwardCache \
  --disable-sync \
  --disable-default-apps \
  --disable-extensions \
  --no-first-run \
  --no-default-browser-check \
  --no-pings \
  --window-position=0,0 \
  --window-size=1280,720 \
  --kiosk \
  --user-data-dir=/tmp/ixl-profile \
  --disk-cache-size=104857600 \
  --media-cache-size=104857600 \
  https://www.ixl.com/signin > /tmp/chrome.log 2>&1 &

echo "[start] chrome pid: $!"
sleep 2
echo "[start] launching node server..."
node server.js