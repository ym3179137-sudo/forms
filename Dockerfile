FROM node:20-bookworm

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    ca-certificates wget curl gnupg \
    xvfb x11vnc \
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

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install chromium --with-deps
RUN find /ms-playwright -maxdepth 3 -type f -name chrome

COPY . .

ENV NODE_ENV=production
ENV DISPLAY=:99

RUN chmod +x /app/start.sh

EXPOSE 3000
CMD ["/app/start.sh"]