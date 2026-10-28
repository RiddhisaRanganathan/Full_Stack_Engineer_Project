# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN --mount=type=secret,id=proxy_ca NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca npm ci --omit=dev --ignore-scripts
COPY --chown=node:node src ./src
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node public ./public
USER node
EXPOSE 3000
CMD ["node","src/server.js"]
