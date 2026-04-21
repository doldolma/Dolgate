FROM --platform=$BUILDPLATFORM golang:1.25-bookworm AS builder

ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev

WORKDIR /src

COPY services/sync-api/go.mod services/sync-api/go.sum /src/services/sync-api/
COPY services/ssh-core/go.mod services/ssh-core/go.sum /src/services/ssh-core/

RUN cd /src/services/sync-api && go mod download
RUN cd /src/services/ssh-core && go mod download

COPY services/sync-api /src/services/sync-api
COPY services/ssh-core /src/services/ssh-core

RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
  sh -c 'cd /src/services/sync-api && go build -trimpath -ldflags="-s -w -X main.version='"${VERSION}"'" -o /out/sync-api ./cmd/api'

FROM debian:bookworm-slim

ARG TARGETARCH
ARG AWS_CLI_VERSION=2.31.29
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    tzdata \
    unzip \
  && case "$TARGETARCH" in \
    amd64) awscli_arch=x86_64; plugin_arch=ubuntu_64bit ;; \
    arm64) awscli_arch=aarch64; plugin_arch=ubuntu_arm64 ;; \
    *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
  esac \
  && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${awscli_arch}-${AWS_CLI_VERSION}.zip" \
    -o /tmp/awscliv2.zip \
  && unzip -q /tmp/awscliv2.zip -d /tmp \
  && /tmp/aws/install --bin-dir /usr/local/bin --install-dir /usr/local/aws-cli --update \
  && rm -rf /tmp/aws /tmp/awscliv2.zip \
  && curl -fsSL "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/${plugin_arch}/session-manager-plugin.deb" \
    -o /tmp/session-manager-plugin.deb \
  && apt-get install -y --no-install-recommends /tmp/session-manager-plugin.deb \
  && rm -f /tmp/session-manager-plugin.deb \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /out/sync-api /app/sync-api

RUN mkdir -p /app/data

ENV TZ=Asia/Seoul

EXPOSE 8080

CMD ["/app/sync-api"]
