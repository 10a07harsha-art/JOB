FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js README.md .env.example ./
COPY public ./public
COPY data/store.example.json ./data/store.example.json

EXPOSE 8000
CMD ["node", "server.js"]
