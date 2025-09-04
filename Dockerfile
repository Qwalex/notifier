FROM node:18-alpine
RUN mkdir -p /opt/app
WORKDIR /opt/app
COPY package.json package-lock.json .
RUN npm install --verbose
COPY index.js .
EXPOSE 3000
CMD [ "npm", "start"]
