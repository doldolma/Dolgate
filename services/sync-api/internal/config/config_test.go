package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadFallsBackToExampleConfig(t *testing.T) {
	tempDir := t.TempDir()
	requestedPath := filepath.Join(tempDir, "default.json")
	examplePath := filepath.Join(tempDir, "default.example.json")
	if err := os.WriteFile(examplePath, []byte(`{"server":{"port":"9090"},"auth":{"signingPrivateKeyPath":"./example-key.pem"}}`), 0o600); err != nil {
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
	if cfg.Server.Port != "9090" || cfg.Auth.SigningPrivateKeyPath != "./example-key.pem" {
		t.Fatalf("cfg = %+v", cfg)
	}
}

func TestLoadAppliesEnvironmentOverrides(t *testing.T) {
	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, "default.json")
	if err := os.WriteFile(configPath, []byte(`{"server":{"port":"8080"},"database":{"driver":"sqlite","url":"file:test.db"},"auth":{"signingPrivateKeyPath":"./from-file.pem","local":{"enabled":true,"signupEnabled":true},"oidc":{"enabled":false,"displayName":"SSO"}}}`), 0o600); err != nil {
		t.Fatalf("os.WriteFile() error = %v", err)
	}

	t.Setenv("DOLSSH_API_CONFIG_PATH", configPath)
	t.Setenv("PORT", "9191")
	t.Setenv("DATABASE_URL", "file:override.db")
	t.Setenv("AUTH_SIGNING_PRIVATE_KEY_PATH", "/secure/override.pem")
	t.Setenv("TRUSTED_PROXIES", "127.0.0.1,10.0.0.0/8")
	t.Setenv("LOCAL_AUTH_ENABLED", "false")
	t.Setenv("OIDC_ENABLED", "true")
	t.Setenv("OIDC_DISPLAY_NAME", "Workspace SSO")

	cfg, _, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.Server.Port != "9191" || cfg.Database.URL != "file:override.db" || cfg.Auth.SigningPrivateKeyPath != "/secure/override.pem" {
		t.Fatalf("cfg = %+v", cfg)
	}
	if len(cfg.Server.TrustedProxies) != 2 || cfg.Server.TrustedProxies[0] != "127.0.0.1" || cfg.Server.TrustedProxies[1] != "10.0.0.0/8" {
		t.Fatalf("cfg.Server.TrustedProxies = %#v", cfg.Server.TrustedProxies)
	}
	if cfg.Auth.Local.Enabled {
		t.Fatalf("cfg.Auth.Local.Enabled = true, want false")
	}
	if !cfg.Auth.OIDC.Enabled || cfg.Auth.OIDC.DisplayName != "Workspace SSO" {
		t.Fatalf("cfg.Auth.OIDC = %+v", cfg.Auth.OIDC)
	}
}

func TestLoadReturnsJSONErrors(t *testing.T) {
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

func TestLoadRejectsLegacyJWTSecretConfig(t *testing.T) {
	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, "production.json")
	if err := os.WriteFile(configPath, []byte(`{"auth":{"jwtSecret":"change-me-in-production"}}`), 0o600); err != nil {
		t.Fatalf("os.WriteFile() error = %v", err)
	}

	t.Setenv("DOLSSH_API_CONFIG_PATH", configPath)

	_, _, err := Load()
	if err == nil || !strings.Contains(err.Error(), "auth.jwtSecret is no longer supported") {
		t.Fatalf("Load() error = %v, want legacy jwtSecret rejection", err)
	}
}

func TestLoadRejectsLegacyOfflineLeaseKeyConfig(t *testing.T) {
	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, "production.json")
	if err := os.WriteFile(configPath, []byte(`{"auth":{"offlineLeaseSigningPrivateKeyPem":"legacy"}}`), 0o600); err != nil {
		t.Fatalf("os.WriteFile() error = %v", err)
	}

	t.Setenv("DOLSSH_API_CONFIG_PATH", configPath)

	_, _, err := Load()
	if err == nil || !strings.Contains(err.Error(), "auth.offlineLeaseSigningPrivateKeyPem is no longer supported") {
		t.Fatalf("Load() error = %v, want legacy offline lease key rejection", err)
	}
}

func TestLoadRejectsLegacyJWTSecretEnvironmentVariable(t *testing.T) {
	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, "default.json")
	if err := os.WriteFile(configPath, []byte(`{"auth":{"signingPrivateKeyPath":"./auth-signing-private.pem"}}`), 0o600); err != nil {
		t.Fatalf("os.WriteFile() error = %v", err)
	}

	t.Setenv("DOLSSH_API_CONFIG_PATH", configPath)
	t.Setenv("JWT_SECRET", "legacy-secret")

	_, _, err := Load()
	if err == nil || !strings.Contains(err.Error(), "JWT_SECRET is no longer supported") {
		t.Fatalf("Load() error = %v, want JWT_SECRET rejection", err)
	}
}
