FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY index.js README.md server.json glama.json ./

CMD ["node", "index.js"]
