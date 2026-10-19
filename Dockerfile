FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

# Baileys and the chat cache need somewhere that survives a redeploy.
VOLUME ["/app/data"]
EXPOSE 3000

CMD ["node", "server.js"]
