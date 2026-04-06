FROM node:18-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/app

COPY package.json package-lock.json ./
ENV NODE_ENV=production

# bookworm-slim вместо alpine: npm в Alpine часто даёт «Exit handler never called» и обрывает установку.
RUN npm ci --omit=dev --no-audit --no-fund \
  && test -f node_modules/express/package.json \
  && test -f node_modules/node-telegram-bot-api/package.json

COPY index.js .
EXPOSE 5656
CMD ["npm", "start"]
