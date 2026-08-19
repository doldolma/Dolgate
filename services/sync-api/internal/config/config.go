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
	// PublicBaseURL은 클라이언트에게 노출할 공개 origin(scheme+host)이다. 세션 공유 viewer URL
	// 생성과 viewer WebSocket origin 검증에 쓰이며, 설정되면 요청의 X-Forwarded-* 헤더를 신뢰하지
	// 않아 origin 스푸핑을 막는다. 리버스 프록시 뒤 배포 시 설정 권장(예: https://sync.example.com).
	PublicBaseURL string `json:"publicBaseUrl"`
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
	WebAuthn                      WebAuthnConfig      `json:"webauthn"`
}

type AuthRateLimitConfig struct {
	Login    AuthRateLimitRuleConfig `json:"login"`
	Signup   AuthRateLimitRuleConfig `json:"signup"`
	Refresh  AuthRateLimitRuleConfig `json:"refresh"`
	Exchange AuthRateLimitRuleConfig `json:"exchange"`
	Password AuthRateLimitRuleConfig `json:"password"`
	Webauthn AuthRateLimitRuleConfig `json:"webauthn"`
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
	// HideOnIOS 는 iOS 앱에서 연 브라우저 로그인(platform=ios)에서만 OIDC 버튼을 숨기는
	// opt-in 플래그다. 기본값(false)에서는 동작 변화가 없다.
	HideOnIOS bool `json:"hideOnIos"`
}

// WebAuthnConfig 는 브라우저 로그인의 패스키(WebAuthn) 로그인 설정이다. Enabled 가 켜져도
// RP(Relying Party) 유도에 실패하면(=HTTPS 도메인 origin 이 아니면) 런타임에서 자동 비활성된다
// — WebAuthn 규격상 평문 HTTP 원격/ IP 리터럴 origin 에서는 동작할 수 없기 때문이다.
// RPID·Origins 를 비워 두면 서버의 PublicBaseURL 에서 자동 유도한다.
type WebAuthnConfig struct {
	Enabled bool `json:"enabled"`
	// RPID 는 Relying Party ID(스킴·포트 없는 등록 가능 도메인, 예: ssh.doldolma.com)다.
	// 비우면 PublicBaseURL 의 호스트에서 유도한다.
	RPID string `json:"rpId"`
	// RPDisplayName 은 인증기 UI 에 노출되는 사람이 읽는 이름이다.
	RPDisplayName string `json:"rpDisplayName"`
	// Origins 는 허용할 Relying Party origin 목록(스킴+호스트+포트)이다. 비우면
	// PublicBaseURL 에서 유도한다. 여러 origin(앱 도메인 등)을 허용하려면 명시한다.
	Origins []string `json:"origins"`
}

func defaultConfig() AppConfig {
	return AppConfig{
		Server: ServerConfig{
			Port:           "8080",
			TrustedProxies: nil,
			PublicBaseURL:  "",
		},
		Database: DatabaseConfig{
			Driver: "sqlite",
			// pragma 는 여기 적지 않는다. withSQLiteDefaults 가 busy_timeout·journal_mode(WAL) 을
			// 채우고, 사용자가 DATABASE_URL 에 적은 것만 존중한다 — 기본값에 하나라도 적어 두면
			// "사용자가 지정한 DSN" 과 구분되지 않는다.
			URL: "file:./data/dolgate_sync.db",
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
				Password: AuthRateLimitRuleConfig{Limit: 5, WindowSeconds: 900},
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
			WebAuthn: WebAuthnConfig{
				Enabled:       false,
				RPDisplayName: "Dolgate",
			},
		},
	}
}

// configSearchPaths 는 DOLSSH_API_CONFIG_PATH 가 없을 때 순서대로 살펴보는 관례 경로다.
// 상대 경로는 작업 디렉터리 기준이며, 컨테이너 이미지의 WORKDIR 이 /app 이므로
// /app/config.json · /app/config/config.json 을 마운트하면 그대로 잡힌다.
var configSearchPaths = []string{
	"config.json",
	"config/config.json",
	"/etc/dolgate/config.json",
}

// findConfigFile 은 관례 경로에서 처음 발견한 설정 파일을 돌려준다. 없으면 빈 문자열.
func findConfigFile() string {
	for _, candidate := range configSearchPaths {
		info, err := os.Stat(candidate)
		if err != nil || info.IsDir() {
			continue
		}
		return candidate
	}
	return ""
}

func Load() (AppConfig, string, error) {
	cfg := defaultConfig()
	configSource := "defaults+env"

	// 명시 경로가 있으면 그것만 쓴다(오타를 조용히 넘기지 않으려고 읽기 실패는 에러).
	// 없으면 관례 경로를 탐색하고, 아무것도 없으면 기본값+환경 변수로만 동작한다.
	configPath := strings.TrimSpace(os.Getenv("DOLSSH_API_CONFIG_PATH"))
	if configPath == "" {
		configPath = findConfigFile()
	}

	if configPath != "" {
		data, err := os.ReadFile(configPath)
		if err != nil {
			return AppConfig{}, configPath, err
		}
		if err := rejectLegacyAuthConfig(data); err != nil {
			return AppConfig{}, configPath, err
		}
		if err := json.Unmarshal(data, &cfg); err != nil {
			return AppConfig{}, configPath, err
		}
		configSource = configPath
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
	cfg.Server.PublicBaseURL = getenv("PUBLIC_BASE_URL", cfg.Server.PublicBaseURL)
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
	cfg.Auth.OIDC.HideOnIOS = getenv("OIDC_HIDE_ON_IOS", boolToString(cfg.Auth.OIDC.HideOnIOS)) == "true"
	cfg.Auth.WebAuthn.Enabled = getenv("WEBAUTHN_ENABLED", boolToString(cfg.Auth.WebAuthn.Enabled)) == "true"
	cfg.Auth.WebAuthn.RPID = getenv("WEBAUTHN_RP_ID", cfg.Auth.WebAuthn.RPID)
	cfg.Auth.WebAuthn.RPDisplayName = getenv("WEBAUTHN_RP_DISPLAY_NAME", cfg.Auth.WebAuthn.RPDisplayName)
	cfg.Auth.WebAuthn.Origins = getenvCSV("WEBAUTHN_ORIGINS", cfg.Auth.WebAuthn.Origins)
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
