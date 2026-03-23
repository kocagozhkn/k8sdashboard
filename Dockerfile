FROM node:20-alpine AS builder
ARG BUILD_SHA=unknown
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
ENV DOCKER_BUILD=1
RUN npm run build

FROM nginx:alpine
ARG BUILD_SHA=unknown
LABEL org.opencontainers.image.revision="${BUILD_SHA}"
ENV PROMETHEUS_UPSTREAM=prometheus.azure-extensions-usage-system.svc.cluster.local:9090
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx-spa-root.conf /etc/nginx/snippets/spa-root.conf
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
