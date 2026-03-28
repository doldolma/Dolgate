package config

import (
	"encoding/json"
	"errors"
	"os"
	"strconv"
	"strings"
)

type AppConfig struct {
	Server   ServerConfig   `json:"server"`
	Database DatabaseConfig `json:"database"`
	Auth     AuthConfig     `json:"auth"`
}

type ServerConfig struct {
	Port           string   `json:"port"`
	TrustedProxies []string `json:"trustedProxies"`
}

type DatabaseConfig struct {
	Driver string `json:"driver"`
	URL    string `json:"url"`
}

type AuthConfig struct {
	SigningPrivateKeyPEM          string              `json:"signingPrivateKeyPem"`
	SigningPrivateKeyPath         string              `json:"signingPrivateKeyPath"`
	AccessTokenTTLMinutes         int                 `json:"accessTokenTtlMinutes"`
	RefreshTokenIdleDays          int                 `json:"refreshTokenIdleDays"`
	OfflineLeaseTTLHours          int                 `json:"offlineLeaseTtlHours"`
	RefreshRotationHandoffSeconds int                 `json:"refreshRotationHandoffSeconds"`
	RateLimit                     AuthRateLimitConfig `json:"rateLimit"`
	Local                         LocalAuthConfig     `json:"local"`
	OIDC                          OIDCConfig          `json:"oidc"`
}

type AuthRateLimitConfig struct {
	Login    AuthRateLimitRuleConfig `json:"login"`
	Signup   AuthRateLimitRuleConfig `json:"signup"`
	Refresh  AuthRateLimitRuleConfig `json:"refresh"`
	Exchange AuthRateLimitRuleConfig `json:"exchange"`
}

type AuthRateLimitRuleConfig struct {
	Limit         int `json:"limit"`
	WindowSeconds int `json:"windowSeconds"`
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
			Port:           "8080",
			TrustedProxies: nil,
		},
		Database: DatabaseConfig{
			Driver: "sqlite",
			URL:    "file:./data/dolgate_sync.db?_pragma=busy_timeout(5000)",
		},
		Auth: AuthConfig{
			SigningPrivateKeyPath:         "./data/auth-signing-private.pem",
			AccessTokenTTLMinutes:         15,
			RefreshTokenIdleDays:          14,
			OfflineLeaseTTLHours:          72,
			RefreshRotationHandoffSeconds: 120,
			RateLimit: AuthRateLimitConfig{
				Login:    AuthRateLimitRuleConfig{Limit: 10, WindowSeconds: 300},
				Signup:   AuthRateLimitRuleConfig{Limit: 5, WindowSeconds: 900},
				Refresh:  AuthRateLimitRuleConfig{Limit: 30, WindowSeconds: 300},
				Exchange: AuthRateLimitRuleConfig{Limit: 30, WindowSeconds: 300},
			},
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
	configSource := "defaults+env"
	if strings.TrimSpace(requestedConfigPath) != "" {
		data, err := os.ReadFile(requestedConfigPath)
		if err != nil {
			return AppConfig{}, requestedConfigPath, err
		}
		if err := rejectLegacyAuthConfig(data); err != nil {
			return AppConfig{}, requestedConfigPath, err
		}
		if err := json.Unmarshal(data, &cfg); err != nil {
			return AppConfig{}, requestedConfigPath, err
		}
		configSource = requestedConfigPath
	}

	applyEnvOverrides(&cfg)
	if err := validateConfig(cfg); err != nil {
		return AppConfig{}, configSource, err
	}
	return cfg, configSource, nil
}

func applyEnvOverrides(cfg *AppConfig) {
	cfg.Database.Driver = getenv("DB_DRIVER", cfg.Database.Driver)
	cfg.Database.URL = getenv("DATABASE_URL", cfg.Database.URL)
	cfg.Server.Port = getenv("PORT", cfg.Server.Port)
	cfg.Server.TrustedProxies = getenvCSV("TRUSTED_PROXIES", cfg.Server.TrustedProxies)
	cfg.Auth.SigningPrivateKeyPEM = getenv("AUTH_SIGNING_PRIVATE_KEY_PEM", cfg.Auth.SigningPrivateKeyPEM)
	cfg.Auth.SigningPrivateKeyPath = getenv("AUTH_SIGNING_PRIVATE_KEY_PATH", cfg.Auth.SigningPrivateKeyPath)
	cfg.Auth.AccessTokenTTLMinutes = getenvInt("ACCESS_TOKEN_TTL_MINUTES", cfg.Auth.AccessTokenTTLMinutes)
	cfg.Auth.RefreshTokenIdleDays = getenvInt("REFRESH_TOKEN_IDLE_DAYS", cfg.Auth.RefreshTokenIdleDays)
	cfg.Auth.OfflineLeaseTTLHours = getenvInt("OFFLINE_LEASE_TTL_HOURS", cfg.Auth.OfflineLeaseTTLHours)
	cfg.Auth.RefreshRotationHandoffSeconds = getenvInt("REFRESH_ROTATION_HANDOFF_SECONDS", cfg.Auth.RefreshRotationHandoffSeconds)
	cfg.Auth.Local.Enabled = getenv("LOCAL_AUTH_ENABLED", boolToString(cfg.Auth.Local.Enabled)) != "false"
	cfg.Auth.Local.SignupEnabled = getenv("LOCAL_SIGNUP_ENABLED", boolToString(cfg.Auth.Local.SignupEnabled)) != "false"
	cfg.Auth.OIDC.Enabled = getenv("OIDC_ENABLED", boolToString(cfg.Auth.OIDC.Enabled)) == "true"
	cfg.Auth.OIDC.DisplayName = getenv("OIDC_DISPLAY_NAME", cfg.Auth.OIDC.DisplayName)
	cfg.Auth.OIDC.IssuerURL = getenv("OIDC_ISSUER_URL", cfg.Auth.OIDC.IssuerURL)
	cfg.Auth.OIDC.ClientID = getenv("OIDC_CLIENT_ID", cfg.Auth.OIDC.ClientID)
	cfg.Auth.OIDC.ClientSecret = getenv("OIDC_CLIENT_SECRET", cfg.Auth.OIDC.ClientSecret)
	cfg.Auth.OIDC.RedirectURL = getenv("OIDC_REDIRECT_URL", cfg.Auth.OIDC.RedirectURL)
	cfg.Auth.OIDC.Scopes = getenvCSV("OIDC_SCOPES", cfg.Auth.OIDC.Scopes)
}

func validateConfig(cfg AppConfig) error {
	if strings.TrimSpace(os.Getenv("JWT_SECRET")) != "" {
		return errors.New("JWT_SECRET is no longer supported; use AUTH_SIGNING_PRIVATE_KEY_PEM or AUTH_SIGNING_PRIVATE_KEY_PATH")
	}
	if strings.TrimSpace(os.Getenv("OFFLINE_LEASE_SIGNING_PRIVATE_KEY_PEM")) != "" {
		return errors.New("OFFLINE_LEASE_SIGNING_PRIVATE_KEY_PEM is no longer supported; use AUTH_SIGNING_PRIVATE_KEY_PEM or AUTH_SIGNING_PRIVATE_KEY_PATH")
	}
	if strings.TrimSpace(cfg.Auth.SigningPrivateKeyPEM) == "" && strings.TrimSpace(cfg.Auth.SigningPrivateKeyPath) == "" {
		return errors.New("auth.signingPrivateKeyPem or auth.signingPrivateKeyPath is required")
	}
	return nil
}

func rejectLegacyAuthConfig(data []byte) error {
	var root map[string]json.RawMessage
	if err := json.Unmarshal(data, &root); err != nil {
		return nil
	}
	authRaw, ok := root["auth"]
	if !ok {
		return nil
	}

	var authSection map[string]json.RawMessage
	if err := json.Unmarshal(authRaw, &authSection); err != nil {
		return nil
	}
	if _, ok := authSection["jwtSecret"]; ok {
		return errors.New("auth.jwtSecret is no longer supported; use auth.signingPrivateKeyPem or auth.signingPrivateKeyPath")
	}
	if _, ok := authSection["offlineLeaseSigningPrivateKeyPem"]; ok {
		return errors.New("auth.offlineLeaseSigningPrivateKeyPem is no longer supported; use auth.signingPrivateKeyPem or auth.signingPrivateKeyPath")
	}
	return nil
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

func getenvInt(key string, fallback int) int {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func getenvCSV(key string, fallback []string) []string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parts := strings.Split(value, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		trimmed := strings.TrimSpace(part)
		if trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}
