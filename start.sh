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

# persistent profile on /data (Railway volume). falls back to /tmp if not mounted.
PROFILE_DIR=/data/ixl-profile
if [ ! -d "/data" ]; then
  PROFILE_DIR=/tmp/ixl-profile
  echo "[start] /data not mounted, using /tmp"
fi
mkdir -p "$PROFILE_DIR"
echo "[start] profile: $PROFILE_DIR"

# build a token for the extension
SOLVE_SECRET=${SOLVE_SECRET:-dev-secret}

echo "[start] launching chromium..."
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
  --disable-features=IsolateOrigins,site-per-process,Translate,BackForwardCache,ChromeWhatsNewUI,ChromeVariations,OptimizationHints,OptimizationGuideModelDownloading,InterestFeedContentSuggestions,MediaRouter,CalculateNativeWinOcclusion \
  --disable-sync \
  --disable-default-apps \
  --disable-extensions-except=/app/chromium-ext \
  --load-extension=/app/chromium-ext \
  --disable-component-update \
  --disable-client-side-phishing-detection \
  --disable-prompt-on-repost \
  --no-first-run \
  --no-default-browser-check \
  --no-pings \
  --test-type \
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