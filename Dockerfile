FROM node:18-alpine
RUN apk add --no-cache curl
RUN mkdir -p /opt/app
WORKDIR /opt/app
COPY package.json package-lock.json .
RUN npm install --verbose
COPY index.js .
EXPOSE 5656
CMD [ "npm", "start"]
