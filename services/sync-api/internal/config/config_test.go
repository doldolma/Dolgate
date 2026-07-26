package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadUsesDefaultsAndEnvironmentWithoutConfigFile(t *testing.T) {
	t.Setenv("PORT", "9191")
	t.Setenv("DATABASE_URL", "file:override.db")
	t.Setenv("AUTH_SIGNING_PRIVATE_KEY_PATH", "/secure/override.pem")
	t.Setenv("TRUSTED_PROXIES", "127.0.0.1,10.0.0.0/8")
	t.Setenv("LOCAL_AUTH_ENABLED", "false")
	t.Setenv("OIDC_ENABLED", "true")
	t.Setenv("OIDC_DISPLAY_NAME", "Workspace SSO")
	t.Setenv("OIDC_SCOPES", "openid,profile,email")
	t.Setenv("OIDC_HIDE_ON_IOS", "true")

	cfg, source, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if source != "defaults+env" {
		t.Fatalf("source = %q, want defaults+env", source)
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
	if len(cfg.Auth.OIDC.Scopes) != 3 || cfg.Auth.OIDC.Scopes[0] != "openid" {
		t.Fatalf("cfg.Auth.OIDC.Scopes = %#v", cfg.Auth.OIDC.Scopes)
	}
	if !cfg.Auth.OIDC.HideOnIOS {
		t.Fatalf("cfg.Auth.OIDC.HideOnIOS = false, want true")
	}
}

func TestLoadReadsExplicitConfigPath(t *testing.T) {
	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, "sync-api.json")
	if err := os.WriteFile(configPath, []byte(`{"server":{"port":"9090"},"auth":{"signingPrivateKeyPath":"./example-key.pem"}}`), 0o600); err != nil {
		t.Fatalf("os.WriteFile() error = %v", err)
	}

	t.Setenv("DOLSSH_API_CONFIG_PATH", configPath)

	cfg, resolvedPath, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if resolvedPath != configPath {
		t.Fatalf("resolvedPath = %q, want %q", resolvedPath, configPath)
	}
	if cfg.Server.Port != "9090" || cfg.Auth.SigningPrivateKeyPath != "./example-key.pem" {
		t.Fatalf("cfg = %+v", cfg)
	}
}

func TestLoadReturnsJSONErrors(t *testing.T) {
	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, "sync-api.json")
	if err := os.WriteFile(configPath, []byte(`{"server":`), 0o600); err != nil {
		t.Fatalf("os.WriteFile() error = %v", err)
	}

	t.Setenv("DOLSSH_API_CONFIG_PATH", configPath)

	if _, _, err := Load(); err == nil {
		t.Fatal("Load() error = nil, want invalid JSON error")
	}
}

func TestLoadRejectsMissingExplicitConfigFile(t *testing.T) {
	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, "missing.json")
	t.Setenv("DOLSSH_API_CONFIG_PATH", configPath)

	if _, _, err := Load(); err == nil {
		t.Fatal("Load() error = nil, want missing file error")
	}
}

func TestLoadRejectsLegacyJWTSecretConfig(t *testing.T) {
	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, "sync-api.json")
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
	configPath := filepath.Join(tempDir, "sync-api.json")
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
	t.Setenv("JWT_SECRET", "legacy-secret")

	_, _, err := Load()
	if err == nil || !strings.Contains(err.Error(), "JWT_SECRET is no longer supported") {
		t.Fatalf("Load() error = %v, want JWT_SECRET rejection", err)
	}
}

// 설정 파일은 DOLSSH_API_CONFIG_PATH 없이도 관례 경로에서 자동으로 잡혀야 한다.
func TestLoadDiscoversConfigFileInWorkingDirectory(t *testing.T) {
	tempDir := t.TempDir()
	chdir(t, tempDir)

	if err := os.WriteFile("config.json", []byte(`{"server":{"port":"9310"}}`), 0o600); err != nil {
		t.Fatalf("os.WriteFile() error = %v", err)
	}

	cfg, source, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if source != "config.json" {
		t.Fatalf("source = %q, want config.json", source)
	}
	if cfg.Server.Port != "9310" {
		t.Fatalf("cfg.Server.Port = %q, want 9310", cfg.Server.Port)
	}
}

func TestLoadDiscoversConfigFileInConfigDirectory(t *testing.T) {
	tempDir := t.TempDir()
	chdir(t, tempDir)

	if err := os.MkdirAll("config", 0o700); err != nil {
		t.Fatalf("os.MkdirAll() error = %v", err)
	}
	configPath := filepath.Join("config", "config.json")
	if err := os.WriteFile(configPath, []byte(`{"server":{"port":"9311"}}`), 0o600); err != nil {
		t.Fatalf("os.WriteFile() error = %v", err)
	}

	cfg, source, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if source != configPath {
		t.Fatalf("source = %q, want %q", source, configPath)
	}
	if cfg.Server.Port != "9311" {
		t.Fatalf("cfg.Server.Port = %q, want 9311", cfg.Server.Port)
	}
}

// 작업 디렉터리의 파일이 config/ 보다 먼저다.
func TestLoadPrefersWorkingDirectoryOverConfigDirectory(t *testing.T) {
	tempDir := t.TempDir()
	chdir(t, tempDir)

	if err := os.WriteFile("config.json", []byte(`{"server":{"port":"9312"}}`), 0o600); err != nil {
		t.Fatalf("os.WriteFile() error = %v", err)
	}
	if err := os.MkdirAll("config", 0o700); err != nil {
		t.Fatalf("os.MkdirAll() error = %v", err)
	}
	if err := os.WriteFile(filepath.Join("config", "config.json"), []byte(`{"server":{"port":"9999"}}`), 0o600); err != nil {
		t.Fatalf("os.WriteFile() error = %v", err)
	}

	cfg, source, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if source != "config.json" || cfg.Server.Port != "9312" {
		t.Fatalf("source = %q, port = %q; want config.json / 9312", source, cfg.Server.Port)
	}
}

// 명시 경로가 있으면 자동 탐색 결과를 무시한다.
func TestLoadExplicitConfigPathWinsOverDiscoveredFile(t *testing.T) {
	tempDir := t.TempDir()
	chdir(t, tempDir)

	if err := os.WriteFile("config.json", []byte(`{"server":{"port":"9313"}}`), 0o600); err != nil {
		t.Fatalf("os.WriteFile() error = %v", err)
	}
	explicitPath := filepath.Join(tempDir, "explicit.json")
	if err := os.WriteFile(explicitPath, []byte(`{"server":{"port":"9314"}}`), 0o600); err != nil {
		t.Fatalf("os.WriteFile() error = %v", err)
	}
	t.Setenv("DOLSSH_API_CONFIG_PATH", explicitPath)

	cfg, source, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if source != explicitPath || cfg.Server.Port != "9314" {
		t.Fatalf("source = %q, port = %q; want %q / 9314", source, cfg.Server.Port, explicitPath)
	}
}

// 설정 파일이 없으면 예전처럼 기본값+환경 변수로 동작한다.
func TestLoadFallsBackWhenNoConfigFileExists(t *testing.T) {
	chdir(t, t.TempDir())

	_, source, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if source != "defaults+env" {
		t.Fatalf("source = %q, want defaults+env", source)
	}
}

func chdir(t *testing.T, dir string) {
	t.Helper()
	previous, err := os.Getwd()
	if err != nil {
		t.Fatalf("os.Getwd() error = %v", err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatalf("os.Chdir() error = %v", err)
	}
	t.Cleanup(func() {
		if err := os.Chdir(previous); err != nil {
			t.Fatalf("os.Chdir(restore) error = %v", err)
		}
	})
}
