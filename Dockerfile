FROM node:18-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/app

COPY package.json package-lock.json ./
ENV NODE_ENV=production
ENV CI=true

# npm 10.x в Docker часто завершается с «Exit handler never called» (баг cli); npm 9 стабильнее
RUN npm install -g npm@9.9.4 \
  && npm --version

RUN npm ci --omit=dev --no-audit --no-fund \
  && test -f node_modules/express/package.json \
  && test -f node_modules/node-telegram-bot-api/package.json

COPY index.js .
EXPOSE 5656
CMD ["npm", "start"]
