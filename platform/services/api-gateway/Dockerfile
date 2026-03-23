# syntax=docker/dockerfile:1
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY main.go ./
RUN go mod tidy && CGO_ENABLED=0 go build -o /out/gateway .

FROM alpine:3.20
RUN apk add --no-cache ca-certificates
COPY --from=build /out/gateway /usr/local/bin/gateway
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/gateway"]
