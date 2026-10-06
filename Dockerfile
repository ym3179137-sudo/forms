FROM node:20-slim

RUN apt-get update && apt-get install -y \
    ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 \
    libatk1.0-0 libcups2 libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 \
    libnspr4 libnss3 libx11-xcb1 libxcomposite1 libxdamage1 libxfixes3 \
    libxkbcommon0 libxrandr2 xdg-utils xvfb openbox \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
RUN npx playwright install chromium --with-deps

COPY . .

ENV NODE_ENV=production
ENV DISPLAY=:99

# start xvfb + openbox (window manager) so chromium thinks it's the focused window
CMD Xvfb :99 -screen 0 1366x768x24 -ac +extension GLX +render -noreset & \
    sleep 1 && \
    openbox --sm-disable & \
    sleep 1 && \
    node server.js