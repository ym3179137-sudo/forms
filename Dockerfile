FROM node:20-bookworm

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    ca-certificates wget curl gnupg \
    xvfb x11vnc openbox xterm \
    xfce4 xfce4-terminal dbus-x11 \
    fluxbox supervisor \
    fonts-liberation fonts-noto \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 \
    libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 libx11-xcb1 \
    libxcomposite1 libxdamage1 libxfixes3 libxkbcommon0 libxrandr2 \
    xdg-utils x11-utils \
    novnc websockify \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
RUN npx playwright install chromium --with-deps

COPY . .

ENV NODE_ENV=production
ENV DISPLAY=:99
ENV SCREEN_WIDTH=1366
ENV SCREEN_HEIGHT=768
ENV SCREEN_DEPTH=24

RUN chmod +x /app/start.sh

EXPOSE 3000
CMD ["/app/start.sh"]