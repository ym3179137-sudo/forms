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

echo "[start] locating chromium binary..."
CHROME_BIN=$(find /ms-playwright -type f -name chrome 2>/dev/null | head -1)
if [ -z "$CHROME_BIN" ]; then
  echo "[start] FATAL: no chromium binary"
  node server.js
  exit 0
fi
echo "[start] chromium: $CHROME_BIN"
chmod +x "$CHROME_BIN" 2>/dev/null

PROFILE_DIR=/data/ixl-profile
if [ ! -d "/data" ]; then
  PROFILE_DIR=/tmp/ixl-profile
fi
mkdir -p "$PROFILE_DIR"

EXT_ARGS=""
if [ -f "/app/chromium-ext/manifest.json" ]; then
  EXT_ARGS="--disable-extensions-except=/app/chromium-ext --load-extension=/app/chromium-ext"
  echo "[start] extension: loaded"
fi

# REAL chrome UA (Windows) so IXL doesn't detect "Chrome for Testing"
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

SOLVE_SECRET=${SOLVE_SECRET:-dev-secret}

echo "[start] launching chromium..."
"$CHROME_BIN" \
  --user-agent="$UA" \
  --no-sandbox \
  --disable-setuid-sandbox \
  --disable-dev-shm-usage \
  --disable-blink-features=AutomationControlled,ChromeForTesting \
  --disable-gpu \
  --disable-software-rasterizer \
  --disable-background-networking \
  --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --disable-features=IsolateOrigins,site-per-process,Translate,BackForwardCache,ChromeWhatsNewUI,ChromeVariations,OptimizationHints,OptimizationGuideModelDownloading,InterestFeedContentSuggestions,MediaRouter,CalculateNativeWinOcclusion \
  --disable-sync \
  --disable-default-apps \
  --exclude-switches=enable-automation \
  $EXT_ARGS \
  --disable-component-update \
  --disable-client-side-phishing-detection \
  --disable-prompt-on-repost \
  --no-first-run \
  --no-default-browser-check \
  --no-pings \
  --app="https://www.ixl.com/signin?ixl_solver_token=${SOLVE_SECRET}" \
  --window-position=0,0 \
  --window-size=1280,720 \
  --user-data-dir="$PROFILE_DIR" \
  --disk-cache-size=209715200 \
  --media-cache-size=52428800 \
  > /tmp/chrome.log 2>&1 &

echo "[start] chrome pid: $!"
sleep 2
echo "[start] launching node server..."
node server.js