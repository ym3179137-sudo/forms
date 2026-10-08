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
if [ ! -d "/data" ]; then PROFILE_DIR=/tmp/ixl-profile; fi
mkdir -p "$PROFILE_DIR"

# ─── proxy handling ─────────────────────────────────────
PROXY_ARGS=""
if [ -n "$PROXY_URL" ]; then
  echo "[start] proxy: ${PROXY_URL%%@*}@***"

  # parse http(s)://user:pass@host:port
  PROTO=$(echo "$PROXY_URL" | sed -E 's#^(https?)://.*#\1#')
  REST=${PROXY_URL#*://}
  CREDS=""
  HOSTPORT="$REST"
  if [[ "$REST" == *"@"* ]]; then
    CREDS="${REST%%@*}"
    HOSTPORT="${REST##*@}"
  fi
  PHOST="${HOSTPORT%%:*}"
  PPORT="${HOSTPORT##*:}"

  if [ -n "$CREDS" ]; then
    PUSER="${CREDS%%:*}"
    PPASS="${CREDS##*:}"
    echo "[start] starting proxy auth forwarder on :8888 → $PHOST:$PPORT as $PUSER"
    # tiny node forwarder that injects Proxy-Authorization
    node -e "
      const http = require('http');
      const net = require('net');
      const auth = 'Basic ' + Buffer.from('${PUSER}:${PPASS}').toString('base64');
      const targetHost = '${PHOST}';
      const targetPort = parseInt('${PPORT}', 10);
      const srv = http.createServer();
      srv.on('connect', (req, clientSocket, head) => {
        const serverSocket = net.connect(targetPort, targetHost, () => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          serverSocket.write(head);
          serverSocket.pipe(clientSocket);
          clientSocket.pipe(serverSocket);
        });
        serverSocket.on('error', () => clientSocket.end());
        clientSocket.on('error', () => serverSocket.end());
      });
      srv.on('request', (req, res) => {
        const opts = {
          host: targetHost,
          port: targetPort,
          method: req.method,
          path: req.url,
          headers: { ...req.headers, 'Proxy-Authorization': auth, host: req.headers.host }
        };
        const p = http.request(opts, (pr) => { res.writeHead(pr.statusCode, pr.headers); pr.pipe(res); });
        p.on('error', () => res.writeHead(502).end());
        req.pipe(p);
      });
      srv.listen(8888, '127.0.0.1', () => console.log('[proxy-auth] listening on :8888'));
    " &
    sleep 1
    PROXY_ARGS="--proxy-server=http://127.0.0.1:8888"
  else
    PROXY_ARGS="--proxy-server=${PROTO}://${PHOST}:${PPORT}"
  fi

  # bypass localhost so /api/solve still reaches our node server
  PROXY_BYPASS="--proxy-bypass-list=127.0.0.1;localhost;*.local"
else
  echo "[start] NO proxy — using datacenter IP (IXL may flag)"
  PROXY_BYPASS=""
fi

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
  $PROXY_ARGS \
  $PROXY_BYPASS \
  --app="https://www.ixl.com/signin?ixl_solver_token=${SOLVE_SECRET}" \
  --window-position=0,0 \
  --window-size=1280,720 \
  --user-data-dir="$PROFILE_DIR" \
  --disk-cache-size=209715200 \
  --media-cache-size=52428800 \
  > /tmp/chrome.log 2>&1 &

echo "[start] chrome pid: $!"
sleep 3
echo "[start] launching node server..."
node server.js