# syntax=docker/dockerfile:1
FROM golang:1.22-alpine AS build
WORKDIR /src
RUN apk add --no-cache ca-certificates git
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/cluster-service ./cmd/cluster-service

FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata
COPY --from=build /out/cluster-service /usr/local/bin/cluster-service
USER 65532:65532
EXPOSE 8081
ENTRYPOINT ["/usr/local/bin/cluster-service"]
