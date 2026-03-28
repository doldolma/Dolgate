FROM --platform=$BUILDPLATFORM golang:1.25-alpine AS builder

ARG TARGETOS
ARG TARGETARCH

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .

# sync-api는 pure Go SQLite 드라이버를 사용하므로 CGO 없이 정적 바이너리로 빌드한다.
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/sync-api ./cmd/api

FROM alpine:3.22

WORKDIR /app

RUN apk add --no-cache ca-certificates tzdata

COPY --from=builder /out/sync-api /app/sync-api

RUN mkdir -p /app/data

ENV TZ=Asia/Seoul

EXPOSE 8080

CMD ["/app/sync-api"]
