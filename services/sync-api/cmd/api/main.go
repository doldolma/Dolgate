package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"

	"dolssh/services/sync-api/internal/auth"
	appconfig "dolssh/services/sync-api/internal/config"
	httpserver "dolssh/services/sync-api/internal/http"
	"dolssh/services/sync-api/internal/store"
)

var version = "dev"

func main() {
	if os.Getenv("GIN_MODE") == "" {
		gin.SetMode(gin.ReleaseMode)
	}

	// 운영 배포와 로컬 개발 모두에서 JSON 설정파일을 기본값으로 사용하고, 필요 시 환경 변수로 덮어쓸 수 있다.
	cfg, configPath, err := appconfig.Load()
	if err != nil {
		log.Fatalf("load config: %v", err)
	}
	log.Printf("sync API config loaded from %s", configPath)

	if err := prepareRuntimePaths(cfg); err != nil {
		log.Fatalf("prepare runtime paths: %v", err)
	}

	dbStore, err := store.Open(cfg.Database.Driver, cfg.Database.URL)
	if err != nil {
		log.Fatalf("open store: %v", err)
	}
	defer func() {
		if err := dbStore.Close(); err != nil {
			log.Printf("close store: %v", err)
		}
	}()

	authService, err := auth.NewService(
		dbStore,
		cfg.Auth.SigningPrivateKeyPEM,
		cfg.Auth.SigningPrivateKeyPath,
		time.Duration(cfg.Auth.AccessTokenTTLMinutes)*time.Minute,
		time.Duration(cfg.Auth.RefreshTokenIdleDays)*24*time.Hour,
		time.Duration(cfg.Auth.OfflineLeaseTTLHours)*time.Hour,
		time.Duration(cfg.Auth.RefreshRotationHandoffSeconds)*time.Second,
	)
	if err != nil {
		log.Fatalf("create auth service: %v", err)
	}
	awsSsmRuntime := httpserver.DetectAwsSsmRuntime()
	awsSsoBrowserFlowEnabled := awsSsmRuntime.AwsSsoBrowserFlowSupported
	var awsSessionBridge *httpserver.AwsSessionBridge
	var awsSftpBridge *httpserver.AwsSftpBridge
	if awsSsmRuntime.Enabled {
		awsSessionBridge = httpserver.NewAwsSessionBridge()
		defer awsSessionBridge.Close()
		awsSftpBridge = httpserver.NewAwsSftpBridge(awsSsmRuntime)
		defer awsSftpBridge.Close()
	}
	var awsSsoMobileManager *httpserver.AwsSsoMobileManager
	if awsSsoBrowserFlowEnabled {
		awsSsoMobileManager = httpserver.NewAwsSsoMobileManager(awsSsmRuntime)
	}
	if awsSsmRuntime.Enabled {
		log.Printf(
			"AWS SSM runtime enabled (aws=%s, plugin=%s)",
			awsSsmRuntime.AWSPath,
			awsSsmRuntime.SessionManagerPluginPath,
		)
	} else {
		log.Printf("AWS SSM runtime unavailable: %s", strings.Join(awsSsmRuntime.MissingTools, ", "))
	}
	if awsSsoBrowserFlowEnabled {
		log.Printf("AWS SSO browser flow enabled (aws=%s)", awsSsmRuntime.AWSPath)
	} else if strings.TrimSpace(awsSsmRuntime.AwsSsoBrowserFlowReason) != "" {
		log.Printf("AWS SSO browser flow unavailable: %s", awsSsmRuntime.AwsSsoBrowserFlowReason)
	}
	router, err := httpserver.NewRouter(dbStore, authService, httpserver.RouterConfig{
		LocalAuthEnabled:   cfg.Auth.Local.Enabled,
		LocalSignupEnabled: cfg.Auth.Local.SignupEnabled,
		TrustedProxies:     cfg.Server.TrustedProxies,
		ServerVersion:      version,
		AwsSsmRuntime:      awsSsmRuntime,
		AwsSsoBrowserFlow:  awsSsoBrowserFlowEnabled,
		RateLimit: httpserver.AuthRateLimitConfig{
			Login: httpserver.RateLimitRuleConfig{
				Limit:         cfg.Auth.RateLimit.Login.Limit,
				WindowSeconds: cfg.Auth.RateLimit.Login.WindowSeconds,
			},
			Signup: httpserver.RateLimitRuleConfig{
				Limit:         cfg.Auth.RateLimit.Signup.Limit,
				WindowSeconds: cfg.Auth.RateLimit.Signup.WindowSeconds,
			},
			Refresh: httpserver.RateLimitRuleConfig{
				Limit:         cfg.Auth.RateLimit.Refresh.Limit,
				WindowSeconds: cfg.Auth.RateLimit.Refresh.WindowSeconds,
			},
			Exchange: httpserver.RateLimitRuleConfig{
				Limit:         cfg.Auth.RateLimit.Exchange.Limit,
				WindowSeconds: cfg.Auth.RateLimit.Exchange.WindowSeconds,
			},
		},
		OIDC: httpserver.OIDCConfig{
			Enabled:      cfg.Auth.OIDC.Enabled,
			DisplayName:  cfg.Auth.OIDC.DisplayName,
			IssuerURL:    cfg.Auth.OIDC.IssuerURL,
			ClientID:     cfg.Auth.OIDC.ClientID,
			ClientSecret: cfg.Auth.OIDC.ClientSecret,
			RedirectURL:  cfg.Auth.OIDC.RedirectURL,
			Scopes:       cfg.Auth.OIDC.Scopes,
		},
		AwsSsoMobile:     awsSsoMobileManager,
		AwsSessionBridge: awsSessionBridge,
		AwsSftpBridge:    awsSftpBridge,
	})
	if err != nil {
		log.Fatalf("create router: %v", err)
	}

	listener, err := net.Listen("tcp", ":"+cfg.Server.Port)
	if err != nil {
		log.Fatalf("listen on :%s: %v", cfg.Server.Port, err)
	}

	server := &http.Server{Handler: router}
	serveErrCh := make(chan error, 1)
	go func() {
		serveErrCh <- server.Serve(listener)
	}()

	log.Printf("sync API listening on :%s (driver=%s)", cfg.Server.Port, cfg.Database.Driver)
	shutdownSignals, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	select {
	case err := <-serveErrCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	case <-shutdownSignals.Done():
		log.Printf("sync API shutdown signal received")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		if err := server.Shutdown(shutdownCtx); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("graceful shutdown failed: %v", err)
		}
		if awsSessionBridge != nil {
			awsSessionBridge.Close()
		}
		if awsSftpBridge != nil {
			awsSftpBridge.Close()
		}
		if err := <-serveErrCh; err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}
}

func prepareRuntimePaths(cfg appconfig.AppConfig) error {
	if cfg.Database.Driver == "sqlite" {
		if err := ensureSQLiteDirectory(cfg.Database.URL); err != nil {
			return err
		}
	}

	if strings.TrimSpace(cfg.Auth.SigningPrivateKeyPEM) == "" {
		if err := ensureParentDirectory(cfg.Auth.SigningPrivateKeyPath, "auth signing key"); err != nil {
			return err
		}
	}

	return nil
}

func ensureSQLiteDirectory(dsn string) error {
	path, ok := sqliteFilePath(dsn)
	if !ok {
		return nil
	}
	return ensureParentDirectory(path, "sqlite database")
}

func sqliteFilePath(dsn string) (string, bool) {
	trimmed := strings.TrimSpace(dsn)
	if trimmed == "" {
		return "", false
	}

	if strings.HasPrefix(trimmed, "file:") {
		trimmed = strings.TrimPrefix(trimmed, "file:")
		if idx := strings.Index(trimmed, "?"); idx >= 0 {
			trimmed = trimmed[:idx]
		}
	}

	trimmed = strings.TrimSpace(trimmed)
	if trimmed == "" || trimmed == ":memory:" || strings.HasPrefix(trimmed, ":memory:") {
		return "", false
	}

	return trimmed, true
}

func ensureParentDirectory(path string, description string) error {
	trimmed := strings.TrimSpace(path)
	if trimmed == "" {
		return nil
	}

	dir := filepath.Dir(trimmed)
	if dir == "." || dir == "" {
		return nil
	}

	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create %s directory %q: %w", description, dir, err)
	}
	return nil
}
