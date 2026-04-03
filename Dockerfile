FROM node:22-alpine AS builder
ARG BUILD_SHA=unknown
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
ENV DOCKER_BUILD=1
RUN npm run build

FROM node:22-alpine
ARG BUILD_SHA=unknown
LABEL org.opencontainers.image.revision="${BUILD_SHA}"
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=80
ENV STATIC_DIR=./dist
ENV SQLITE_PATH=/app/data/auth.db
ENV PROMETHEUS_UPSTREAM=prometheus.azure-extensions-usage-system.svc.cluster.local:9090
ENV K8S_PROXY_TARGET=http://127.0.0.1:8001
RUN mkdir -p /app/data
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
COPY server ./server
EXPOSE 80
CMD ["node", "server/index.mjs"]
