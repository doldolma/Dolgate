FROM golang:1.25-alpine AS builder

WORKDIR /src

RUN apk add --no-cache build-base

COPY go.mod go.sum ./
RUN go mod download

COPY . .

# SQLite 드라이버가 CGO를 사용하므로 linux 배포 바이너리는 musl 기반으로 빌드한다.
RUN CGO_ENABLED=1 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out/sync-api ./cmd/api

FROM alpine:3.22

WORKDIR /app

RUN apk add --no-cache ca-certificates tzdata

COPY --from=builder /out/sync-api /app/sync-api

RUN mkdir -p /app/config /app/data

ENV DOLSSH_API_CONFIG_PATH=/app/config/production.json
ENV TZ=Asia/Seoul

EXPOSE 8080

CMD ["/app/sync-api"]
