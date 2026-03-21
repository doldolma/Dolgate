package config

import (
	"encoding/json"
	"os"
	"path/filepath"
)

type AppConfig struct {
	Server   ServerConfig   `json:"server"`
	Database DatabaseConfig `json:"database"`
	Auth     AuthConfig     `json:"auth"`
}

type ServerConfig struct {
	Port string `json:"port"`
}

type DatabaseConfig struct {
	Driver string `json:"driver"`
	URL    string `json:"url"`
}

type AuthConfig struct {
	JWTSecret             string          `json:"jwtSecret"`
	AccessTokenTTLMinutes int             `json:"accessTokenTtlMinutes"`
	RefreshTokenIdleDays  int             `json:"refreshTokenIdleDays"`
	Local                 LocalAuthConfig `json:"local"`
	OIDC                  OIDCConfig      `json:"oidc"`
}

type LocalAuthConfig struct {
	Enabled       bool `json:"enabled"`
	SignupEnabled bool `json:"signupEnabled"`
}

type OIDCConfig struct {
	Enabled      bool     `json:"enabled"`
	DisplayName  string   `json:"displayName"`
	IssuerURL    string   `json:"issuerUrl"`
	ClientID     string   `json:"clientId"`
	ClientSecret string   `json:"clientSecret"`
	RedirectURL  string   `json:"redirectUrl"`
	Scopes       []string `json:"scopes"`
}

func defaultConfig() AppConfig {
	return AppConfig{
		Server: ServerConfig{
			Port: "8080",
		},
		Database: DatabaseConfig{
			Driver: "sqlite",
			URL:    "file:dolssh_sync.db?_pragma=busy_timeout(5000)",
		},
		Auth: AuthConfig{
			JWTSecret:             "dev-dolssh-secret",
			AccessTokenTTLMinutes: 15,
			RefreshTokenIdleDays:  14,
			Local: LocalAuthConfig{
				Enabled:       true,
				SignupEnabled: true,
			},
			OIDC: OIDCConfig{
				Enabled:     false,
				DisplayName: "SSO",
				RedirectURL: "https://ssh.doldolma.com/auth/oidc/callback",
			},
		},
	}
}

func Load() (AppConfig, string, error) {
	cfg := defaultConfig()
	requestedConfigPath := os.Getenv("DOLSSH_API_CONFIG_PATH")
	if requestedConfigPath == "" {
		requestedConfigPath = filepath.Join(".", "config", "default.json")
	}

	data, configPath, err := readConfigFileWithExampleFallback(requestedConfigPath)
	if err != nil {
		return AppConfig{}, requestedConfigPath, err
	}
	if len(data) > 0 {
		if err := json.Unmarshal(data, &cfg); err != nil {
			return AppConfig{}, configPath, err
		}
	}

	applyEnvOverrides(&cfg)
	return cfg, configPath, nil
}

func readConfigFileWithExampleFallback(requestedPath string) ([]byte, string, error) {
	candidates := []string{requestedPath}
	if filepath.Ext(requestedPath) == ".json" {
		candidates = append(candidates, requestedPath[:len(requestedPath)-len(".json")]+".example.json")
	}

	for _, candidate := range candidates {
		data, err := os.ReadFile(candidate)
		if err == nil {
			return data, candidate, nil
		}
		if !os.IsNotExist(err) {
			return nil, candidate, err
		}
	}

	return nil, requestedPath, nil
}

func applyEnvOverrides(cfg *AppConfig) {
	cfg.Database.Driver = getenv("DB_DRIVER", cfg.Database.Driver)
	cfg.Database.URL = getenv("DATABASE_URL", cfg.Database.URL)
	cfg.Server.Port = getenv("PORT", cfg.Server.Port)
	cfg.Auth.JWTSecret = getenv("JWT_SECRET", cfg.Auth.JWTSecret)
	cfg.Auth.Local.Enabled = getenv("LOCAL_AUTH_ENABLED", boolToString(cfg.Auth.Local.Enabled)) != "false"
	cfg.Auth.Local.SignupEnabled = getenv("LOCAL_SIGNUP_ENABLED", boolToString(cfg.Auth.Local.SignupEnabled)) != "false"
	cfg.Auth.OIDC.Enabled = getenv("OIDC_ENABLED", boolToString(cfg.Auth.OIDC.Enabled)) == "true"
	cfg.Auth.OIDC.DisplayName = getenv("OIDC_DISPLAY_NAME", cfg.Auth.OIDC.DisplayName)
	cfg.Auth.OIDC.IssuerURL = getenv("OIDC_ISSUER_URL", cfg.Auth.OIDC.IssuerURL)
	cfg.Auth.OIDC.ClientID = getenv("OIDC_CLIENT_ID", cfg.Auth.OIDC.ClientID)
	cfg.Auth.OIDC.ClientSecret = getenv("OIDC_CLIENT_SECRET", cfg.Auth.OIDC.ClientSecret)
	cfg.Auth.OIDC.RedirectURL = getenv("OIDC_REDIRECT_URL", cfg.Auth.OIDC.RedirectURL)
}

func getenv(key string, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	return value
}

func boolToString(value bool) string {
	if value {
		return "true"
	}
	return "false"
}
