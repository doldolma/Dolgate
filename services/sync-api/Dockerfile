FROM --platform=$BUILDPLATFORM golang:1.26-bookworm AS builder

ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev

WORKDIR /src

COPY services/sync-api/go.mod services/sync-api/go.sum /src/services/sync-api/
COPY services/ssh-core/go.mod services/ssh-core/go.sum /src/services/ssh-core/
COPY services/ssh-core/third_party/tailscale/go.mod /src/services/ssh-core/third_party/tailscale/go.mod

RUN cd /src/services/sync-api && go mod download
RUN cd /src/services/ssh-core && go mod download

COPY services/sync-api /src/services/sync-api
COPY services/ssh-core /src/services/ssh-core

RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
  sh -c 'cd /src/services/sync-api && go build -trimpath -ldflags="-s -w -X main.version='"${VERSION}"'" -o /out/sync-api ./cmd/api'

FROM debian:bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    tzdata \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /out/sync-api /app/sync-api

RUN mkdir -p /app/data

ENV TZ=Asia/Seoul

EXPOSE 8080

CMD ["/app/sync-api"]
