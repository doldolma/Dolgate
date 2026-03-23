package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadFallsBackToExampleConfig(t *testing.T) {
	tempDir := t.TempDir()
	requestedPath := filepath.Join(tempDir, "default.json")
	examplePath := filepath.Join(tempDir, "default.example.json")
	if err := os.WriteFile(examplePath, []byte(`{"server":{"port":"9090"},"auth":{"jwtSecret":"example-secret"}}`), 0o600); err != nil {
		t.Fatalf("os.WriteFile() error = %v", err)
	}

	t.Setenv("DOLSSH_API_CONFIG_PATH", requestedPath)

	cfg, resolvedPath, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if resolvedPath != examplePath {
		t.Fatalf("resolvedPath = %q, want %q", resolvedPath, examplePath)
	}
	if cfg.Server.Port != "9090" || cfg.Auth.JWTSecret != "example-secret" {
		t.Fatalf("cfg = %+v", cfg)
	}
}

func TestLoadAppliesEnvironmentOverrides(t *testing.T) {
	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, "default.json")
	if err := os.WriteFile(configPath, []byte(`{"server":{"port":"8080"},"database":{"driver":"sqlite","url":"file:test.db"},"auth":{"jwtSecret":"from-file","local":{"enabled":true,"signupEnabled":true},"oidc":{"enabled":false,"displayName":"SSO"}}}`), 0o600); err != nil {
		t.Fatalf("os.WriteFile() error = %v", err)
	}

	t.Setenv("DOLSSH_API_CONFIG_PATH", configPath)
	t.Setenv("PORT", "9191")
	t.Setenv("DATABASE_URL", "file:override.db")
	t.Setenv("JWT_SECRET", "override-secret")
	t.Setenv("LOCAL_AUTH_ENABLED", "false")
	t.Setenv("OIDC_ENABLED", "true")
	t.Setenv("OIDC_DISPLAY_NAME", "Workspace SSO")

	cfg, _, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.Server.Port != "9191" || cfg.Database.URL != "file:override.db" || cfg.Auth.JWTSecret != "override-secret" {
		t.Fatalf("cfg = %+v", cfg)
	}
	if cfg.Auth.Local.Enabled {
		t.Fatalf("cfg.Auth.Local.Enabled = true, want false")
	}
	if !cfg.Auth.OIDC.Enabled || cfg.Auth.OIDC.DisplayName != "Workspace SSO" {
		t.Fatalf("cfg.Auth.OIDC = %+v", cfg.Auth.OIDC)
	}
}

func TestLoadReturnsJsonErrors(t *testing.T) {
	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, "default.json")
	if err := os.WriteFile(configPath, []byte(`{"server":`), 0o600); err != nil {
		t.Fatalf("os.WriteFile() error = %v", err)
	}

	t.Setenv("DOLSSH_API_CONFIG_PATH", configPath)

	if _, _, err := Load(); err == nil {
		t.Fatal("Load() error = nil, want invalid JSON error")
	}
}
