FROM golang:1.25-alpine AS builder

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .

# sync-api는 pure Go SQLite 드라이버를 사용하므로 CGO 없이 정적 바이너리로 빌드한다.
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out/sync-api ./cmd/api

FROM alpine:3.22

WORKDIR /app

RUN apk add --no-cache ca-certificates tzdata

COPY --from=builder /out/sync-api /app/sync-api

RUN mkdir -p /app/config /app/data

ENV DOLSSH_API_CONFIG_PATH=/app/config/production.json
ENV TZ=Asia/Seoul

EXPOSE 8080

CMD ["/app/sync-api"]
