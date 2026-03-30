package main

import (
	"os"
	"path/filepath"
	"testing"

	appconfig "dolssh/services/sync-api/internal/config"
)

func TestPrepareRuntimePathsCreatesSQLiteAndSigningKeyDirectories(t *testing.T) {
	tempDir := t.TempDir()
	sqliteDir := filepath.Join(tempDir, "data")
	keyDir := filepath.Join(tempDir, "keys")
	cfg := appconfig.AppConfig{
		Database: appconfig.DatabaseConfig{
			Driver: "sqlite",
			URL:    "file:" + filepath.Join(sqliteDir, "dolgate_sync.db") + "?_pragma=busy_timeout(5000)",
		},
		Auth: appconfig.AuthConfig{
			SigningPrivateKeyPath: filepath.Join(keyDir, "auth-signing-private.pem"),
		},
	}

	if err := prepareRuntimePaths(cfg); err != nil {
		t.Fatalf("prepareRuntimePaths() error = %v", err)
	}

	if _, err := os.Stat(sqliteDir); err != nil {
		t.Fatalf("sqlite dir stat error = %v", err)
	}
	if _, err := os.Stat(keyDir); err != nil {
		t.Fatalf("key dir stat error = %v", err)
	}
}

func TestPrepareRuntimePathsSkipsNonFileSQLiteTargets(t *testing.T) {
	tempDir := t.TempDir()
	cfg := appconfig.AppConfig{
		Database: appconfig.DatabaseConfig{
			Driver: "sqlite",
			URL:    "file::memory:?cache=shared",
		},
		Auth: appconfig.AuthConfig{
			SigningPrivateKeyPEM: "inline-key",
		},
	}

	if err := prepareRuntimePaths(cfg); err != nil {
		t.Fatalf("prepareRuntimePaths() error = %v", err)
	}

	entries, err := os.ReadDir(tempDir)
	if err != nil {
		t.Fatalf("ReadDir() error = %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("expected no directories, found %d entries", len(entries))
	}
}

func TestPrepareRuntimePathsSkipsMySQLDatabaseDirectoryCreation(t *testing.T) {
	tempDir := t.TempDir()
	keyDir := filepath.Join(tempDir, "keys")
	cfg := appconfig.AppConfig{
		Database: appconfig.DatabaseConfig{
			Driver: "mysql",
			URL:    "user:pass@tcp(localhost:3306)/dolgate",
		},
		Auth: appconfig.AuthConfig{
			SigningPrivateKeyPath: filepath.Join(keyDir, "auth-signing-private.pem"),
		},
	}

	if err := prepareRuntimePaths(cfg); err != nil {
		t.Fatalf("prepareRuntimePaths() error = %v", err)
	}

	if _, err := os.Stat(keyDir); err != nil {
		t.Fatalf("key dir stat error = %v", err)
	}

	entries, err := os.ReadDir(tempDir)
	if err != nil {
		t.Fatalf("ReadDir() error = %v", err)
	}
	if len(entries) != 1 || entries[0].Name() != "keys" || !entries[0].IsDir() {
		t.Fatalf("expected only signing key directory, found %+v", entries)
	}
}
