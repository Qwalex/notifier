FROM node:18-alpine
RUN apk add --no-cache curl
WORKDIR /opt/app

COPY package.json package-lock.json ./
ENV NODE_ENV=production

# Явная установка зависимостей; при сборке проверяем, что модули на месте
RUN npm ci --omit=dev && \
  node -e "require('express'); require('cors'); require('dotenv'); require('node-telegram-bot-api');"

COPY index.js .
EXPOSE 5656
CMD ["npm", "start"]
