package main

import (
	"log"
	"os"
	"time"

	"keyterm/services/sync-api/internal/auth"
	httpserver "keyterm/services/sync-api/internal/http"
	"keyterm/services/sync-api/internal/store"
)

func main() {
	// 운영 배포와 로컬 개발 모두를 위해 환경 변수 기반 설정을 사용한다.
	dbDriver := getenv("DB_DRIVER", "sqlite")
	port := getenv("PORT", "8080")
	databaseURL := getenv("DATABASE_URL", "file:keyterm_sync.db?_pragma=busy_timeout(5000)")
	jwtSecret := getenv("JWT_SECRET", "dev-keyterm-secret")

	dbStore, err := store.Open(dbDriver, databaseURL)
	if err != nil {
		log.Fatalf("open store: %v", err)
	}

	authService := auth.NewService(dbStore, jwtSecret, 15*time.Minute, 7*24*time.Hour)
	router := httpserver.NewRouter(dbStore, authService)

	log.Printf("sync API listening on :%s (driver=%s)", port, dbDriver)
	if err := router.Run(":" + port); err != nil {
		log.Fatal(err)
	}
}

func getenv(key string, fallback string) string {
	// 값이 비어 있으면 안전한 개발 기본값을 사용한다.
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	return value
}
