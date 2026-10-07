#!/bin/bash
set +e

echo "[start] booting Xvfb..."
Xvfb :99 -screen 0 1280x720x24 -ac +extension GLX +render -noreset &
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
CHROME_BIN=$(find /ms-playwright -type f -name chrome 2>/dev/null | head -1)
if [ -z "$CHROME_BIN" ]; then
  CHROME_BIN=$(find /ms-playwright -type f -name 'chrome*' 2>/dev/null | head -1)
fi

if [ -z "$CHROME_BIN" ]; then
  echo "[start] FATAL: no chromium binary. dumping tree:"
  find /ms-playwright -maxdepth 4 -type d 2>/dev/null
  find /ms-playwright -maxdepth 4 -type f -name 'chrome*' 2>/dev/null
else
  echo "[start] chromium: $CHROME_BIN"
  chmod +x "$CHROME_BIN" 2>/dev/null
  echo "[start] launching chromium on IXL..."
  "$CHROME_BIN" \
    --no-sandbox \
    --disable-setuid-sandbox \
    --disable-dev-shm-usage \
    --disable-blink-features=AutomationControlled \
    --disable-gpu \
    --window-position=0,0 \
    --window-size=1280,720 \
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
  sleep 3
  echo "[start] chrome log:"
  cat /tmp/chrome.log 2>/dev/null | head -20
fi

echo "[start] launching node server..."
node server.js