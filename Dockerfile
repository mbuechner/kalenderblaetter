FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./server.js
COPY web ./web

# Rechte so setzen, dass der non-root User lesen kann
RUN chown -R node:node /app

USER node

EXPOSE 8080
ENV PORT=8080 NODE_ENV=production
CMD ["node", "server.js"]
