# syntax=docker/dockerfile:1
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /out/agent-hub-service ./cmd/agent-hub-service

FROM alpine:3.20
RUN apk add --no-cache ca-certificates
COPY --from=build /out/agent-hub-service /usr/local/bin/agent-hub-service
USER 65532:65532
EXPOSE 8086
ENTRYPOINT ["/usr/local/bin/agent-hub-service"]
