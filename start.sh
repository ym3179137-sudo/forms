#!/bin/bash
set +e

echo "[start] booting Xvfb..."
Xvfb :99 -screen 0 1280x720x24 -ac +extension GLX +render -noreset -nolisten tcp &
export DISPLAY=:99
sleep 1

echo "[start] booting x11vnc..."
x11vnc -display :99 -nopw -forever -shared -rfbport 5900 -xkb -noxrecord -noxfixes -noxdamage -wait 5 -defer 5 -threads -ping 5 &
sleep 1

echo "[start] booting websockify on :6080..."
websockify --web /usr/share/novnc 6080 localhost:5900 &
sleep 1

CHROME_BIN="/usr/bin/google-chrome-stable"
if [ ! -f "$CHROME_BIN" ]; then
  CHROME_BIN=$(find /ms-playwright -type f -name chrome 2>/dev/null | head -1)
fi
echo "[start] chrome: $CHROME_BIN"

PROFILE_DIR=/data/ixl-profile
if [ ! -d "/data" ]; then
  PROFILE_DIR=/tmp/ixl-profile
fi
mkdir -p "$PROFILE_DIR"

SOLVE_SECRET=${SOLVE_SECRET:-dev-secret}

echo "[start] launching chrome..."
"$CHROME_BIN" \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-blink-features=AutomationControlled \
  --disable-gpu \
  --disable-software-rasterizer \
  --disable-background-networking \
  --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --disable-features=IsolateOrigins,site-per-process,Translate,BackForwardCache,ChromeWhatsNewUI,ChromeVariations,OptimizationHints,MediaRouter,CalculateNativeWinOcclusion \
  --disable-sync \
  --disable-default-apps \
  --disable-component-update \
  --disable-client-side-phishing-detection \
  --disable-prompt-on-repost \
  --disable-infobars \
  --no-first-run \
  --no-default-browser-check \
  --no-pings \
  --password-store=basic \
  --use-mock-keychain \
  --remote-debugging-port=9222 \
  --remote-debugging-address=127.0.0.1 \
  --remote-allow-origins=* \
  --enable-features=NetworkServiceInProcess2 \
  --enable-quic \
  --disk-cache-size=536870912 \
  --media-cache-size=134217728 \
  --app="https://www.ixl.com/signin?ixl_solver_token=${SOLVE_SECRET}" \
  --window-position=0,0 \
  --window-size=1280,720 \
  --user-data-dir="$PROFILE_DIR" \
  > /tmp/chrome.log 2>&1 &

echo "[start] chrome pid: $!"
sleep 3
echo "[start] launching node server..."
node server.js