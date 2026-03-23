# syntax=docker/dockerfile:1
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY main.go ./
RUN go mod tidy && CGO_ENABLED=0 go build -o /out/policy .

FROM alpine:3.20
COPY --from=build /out/policy /usr/local/bin/policy-service
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/policy-service"]
