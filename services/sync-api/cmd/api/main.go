package main

import (
	"log"
	"time"

	"dolssh/services/sync-api/internal/auth"
	appconfig "dolssh/services/sync-api/internal/config"
	httpserver "dolssh/services/sync-api/internal/http"
	"dolssh/services/sync-api/internal/store"
)

func main() {
	// 운영 배포와 로컬 개발 모두에서 JSON 설정파일을 기본값으로 사용하고, 필요 시 환경 변수로 덮어쓸 수 있다.
	cfg, configPath, err := appconfig.Load()
	if err != nil {
		log.Fatalf("load config: %v", err)
	}
	log.Printf("sync API config loaded from %s", configPath)

	dbStore, err := store.Open(cfg.Database.Driver, cfg.Database.URL)
	if err != nil {
		log.Fatalf("open store: %v", err)
	}
	defer func() {
		if err := dbStore.Close(); err != nil {
			log.Printf("close store: %v", err)
		}
	}()

	authService := auth.NewService(
		dbStore,
		cfg.Auth.JWTSecret,
		time.Duration(cfg.Auth.AccessTokenTTLMinutes)*time.Minute,
		time.Duration(cfg.Auth.RefreshTokenIdleDays)*24*time.Hour,
	)
	router, err := httpserver.NewRouter(dbStore, authService, httpserver.RouterConfig{
		LocalAuthEnabled:   cfg.Auth.Local.Enabled,
		LocalSignupEnabled: cfg.Auth.Local.SignupEnabled,
		OIDC: httpserver.OIDCConfig{
			Enabled:      cfg.Auth.OIDC.Enabled,
			DisplayName:  cfg.Auth.OIDC.DisplayName,
			IssuerURL:    cfg.Auth.OIDC.IssuerURL,
			ClientID:     cfg.Auth.OIDC.ClientID,
			ClientSecret: cfg.Auth.OIDC.ClientSecret,
			RedirectURL:  cfg.Auth.OIDC.RedirectURL,
			Scopes:       cfg.Auth.OIDC.Scopes,
		},
	})
	if err != nil {
		log.Fatalf("create router: %v", err)
	}

	log.Printf("sync API listening on :%s (driver=%s)", cfg.Server.Port, cfg.Database.Driver)
	if err := router.Run(":" + cfg.Server.Port); err != nil {
		log.Fatal(err)
	}
}
