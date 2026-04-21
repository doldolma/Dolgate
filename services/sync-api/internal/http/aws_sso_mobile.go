package http

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

const (
	awsSsoAuthorizationCodeGrantType = "authorization_code"
	awsSsoRefreshTokenGrantType      = "refresh_token"
	awsSsoRegistrationScope          = "sso:account:access"
	awsSsoLoginTTL                   = 10 * time.Minute
	awsSsoCredentialGrace            = 60 * time.Second
	awsCliTimeout                    = 30 * time.Second
	awsSsoAuthorizeURLPattern        = "https://oidc.%s.amazonaws.com/authorize"
)

type awsSsoPendingLogin struct {
	LoginID                string
	UserID                 string
	Fingerprint            string
	Request                awsSsoMobileLoginStartRequest
	ClientID               string
	ClientSecret           string
	RedirectURI            string
	State                  string
	CodeVerifier           string
	BrowserURL             string
	ExpiresAt              time.Time
	Cancelled              bool
	ResolvedCredential     *awsTemporaryCredentialPayload
	ResolvedCredentialTime time.Time
	LastMessage            string
}

type awsSsoCredentialCacheEntry struct {
	UserID             string
	Fingerprint        string
	Request            awsSsoMobileLoginStartRequest
	ClientID           string
	ClientSecret       string
	AccessToken        string
	AccessTokenExpires time.Time
	RefreshToken       string
	Credential         *awsTemporaryCredentialPayload
	CredentialExpires  time.Time
	UpdatedAt          time.Time
}

type AwsSsoMobileManager struct {
	runtime       AwsSsmRuntime
	mu            sync.Mutex
	pendingByID   map[string]*awsSsoPendingLogin
	pendingByKey  map[string]string
	credentialMap map[string]*awsSsoCredentialCacheEntry
}

func NewAwsSsoMobileManager(runtime AwsSsmRuntime) *AwsSsoMobileManager {
	return &AwsSsoMobileManager{
		runtime:       runtime,
		pendingByID:   make(map[string]*awsSsoPendingLogin),
		pendingByKey:  make(map[string]string),
		credentialMap: make(map[string]*awsSsoCredentialCacheEntry),
	}
}

func (manager *AwsSsoMobileManager) Start(
	ctx context.Context,
	userID string,
	request awsSsoMobileLoginStartRequest,
) (awsSsoMobileLoginStartResponse, error) {
	if strings.TrimSpace(manager.runtime.AWSPath) == "" {
		return awsSsoMobileLoginStartResponse{}, errors.New("AWS CLI가 서버에 준비되지 않았습니다.")
	}
	if err := validateLoopbackRedirectURI(request.RedirectURI); err != nil {
		return awsSsoMobileLoginStartResponse{}, err
	}

	cacheKey := manager.cacheKey(userID, request)
	manager.mu.Lock()
	manager.pruneLocked(time.Now())
	if cached := manager.credentialMap[cacheKey]; cached != nil {
		if ready := manager.readyCredentialFromCacheLocked(cached); ready != nil {
			response := awsSsoMobileLoginStartResponse{
				LoginID:    "",
				Status:     "ready",
				Credential: ready,
				Message:    "cached",
				ExpiresAt:  ready.ExpiresAt,
			}
			manager.mu.Unlock()
			return response, nil
		}
	}
	if pendingID := manager.pendingByKey[cacheKey]; pendingID != "" {
		if pending := manager.pendingByID[pendingID]; pending != nil && !pending.Cancelled && time.Now().Before(pending.ExpiresAt) {
			if pending.RedirectURI == request.RedirectURI {
				response := awsSsoMobileLoginStartResponse{
					LoginID:    pending.LoginID,
					Status:     "pending",
					BrowserURL: pending.BrowserURL,
					ExpiresAt:  pending.ExpiresAt.Format(time.RFC3339),
					Message:    pending.LastMessage,
				}
				manager.mu.Unlock()
				return response, nil
			}
			delete(manager.pendingByID, pendingID)
			delete(manager.pendingByKey, cacheKey)
		}
	}
	manager.mu.Unlock()

	if ready, err := manager.tryResolveCachedCredential(ctx, cacheKey, request); err == nil && ready != nil {
		return awsSsoMobileLoginStartResponse{
			LoginID:    "",
			Status:     "ready",
			Credential: ready,
			ExpiresAt:  ready.ExpiresAt,
			Message:    "cached",
		}, nil
	}

	registration, err := manager.registerClient(ctx, request)
	if err != nil {
		return awsSsoMobileLoginStartResponse{}, err
	}

	state, err := randomPKCEValue(24)
	if err != nil {
		return awsSsoMobileLoginStartResponse{}, err
	}
	codeVerifier, err := randomPKCEValue(32)
	if err != nil {
		return awsSsoMobileLoginStartResponse{}, err
	}
	codeChallenge := sha256.Sum256([]byte(codeVerifier))
	browserURL, err := buildAuthorizationURL(
		request.SsoRegion,
		registration.ClientID,
		request.RedirectURI,
		state,
		base64.RawURLEncoding.EncodeToString(codeChallenge[:]),
	)
	if err != nil {
		return awsSsoMobileLoginStartResponse{}, err
	}

	login := &awsSsoPendingLogin{
		LoginID:      uuid.NewString(),
		UserID:       userID,
		Fingerprint:  manager.fingerprint(request),
		Request:      request,
		ClientID:     registration.ClientID,
		ClientSecret: registration.ClientSecret,
		RedirectURI:  request.RedirectURI,
		State:        state,
		CodeVerifier: codeVerifier,
		BrowserURL:   browserURL,
		ExpiresAt:    time.Now().Add(awsSsoLoginTTL),
		LastMessage:  "브라우저에서 AWS 로그인을 진행해 주세요.",
	}

	manager.mu.Lock()
	manager.pruneLocked(time.Now())
	manager.pendingByID[login.LoginID] = login
	manager.pendingByKey[cacheKey] = login.LoginID
	manager.mu.Unlock()

	return awsSsoMobileLoginStartResponse{
		LoginID:    login.LoginID,
		Status:     "pending",
		BrowserURL: login.BrowserURL,
		ExpiresAt:  login.ExpiresAt.Format(time.RFC3339),
		Message:    login.LastMessage,
	}, nil
}

func (manager *AwsSsoMobileManager) Status(
	userID string,
	loginID string,
) (awsSsoMobileHandoffResponse, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()

	manager.pruneLocked(time.Now())
	pending := manager.pendingByID[loginID]
	if pending == nil || pending.UserID != userID {
		return awsSsoMobileHandoffResponse{}, errors.New("AWS SSO 로그인 상태를 찾지 못했습니다.")
	}
	return manager.pendingResponseLocked(pending), nil
}

func (manager *AwsSsoMobileManager) Complete(
	ctx context.Context,
	userID string,
	loginID string,
	request awsSsoMobileLoginHandoffRequest,
) (awsSsoMobileHandoffResponse, error) {
	manager.mu.Lock()
	manager.pruneLocked(time.Now())
	pending := manager.pendingByID[loginID]
	if pending == nil || pending.UserID != userID {
		manager.mu.Unlock()
		return awsSsoMobileHandoffResponse{}, errors.New("AWS SSO 로그인 상태를 찾지 못했습니다.")
	}
	if pending.Cancelled || time.Now().After(pending.ExpiresAt) || (pending.ResolvedCredential != nil && time.Now().Before(pending.ResolvedCredentialTime)) {
		response := manager.pendingResponseLocked(pending)
		manager.mu.Unlock()
		return response, nil
	}
	if request.Error != "" {
		response := manager.failPendingLocked(pending, normalizeAwsSsoCallbackError(request))
		manager.mu.Unlock()
		return response, nil
	}
	if strings.TrimSpace(request.Code) == "" {
		response := manager.failPendingLocked(pending, "AWS SSO 인증 코드를 받지 못했습니다.")
		manager.mu.Unlock()
		return response, nil
	}
	if strings.TrimSpace(request.State) != pending.State {
		response := manager.failPendingLocked(pending, "AWS SSO 상태 검증에 실패했습니다.")
		manager.mu.Unlock()
		return response, nil
	}

	requestProfile := pending.Request
	cacheKey := manager.cacheKey(userID, requestProfile)
	clientID := pending.ClientID
	clientSecret := pending.ClientSecret
	redirectURI := pending.RedirectURI
	codeVerifier := pending.CodeVerifier
	manager.mu.Unlock()

	tokenResult, err := manager.createAuthorizationCodeToken(
		ctx,
		requestProfile.SsoRegion,
		clientID,
		clientSecret,
		request.Code,
		redirectURI,
		codeVerifier,
	)
	if err != nil {
		return manager.failPending(loginID, err.Error())
	}

	credential, err := manager.getRoleCredential(
		ctx,
		requestProfile.SsoRegion,
		requestProfile.SsoAccountID,
		requestProfile.SsoRoleName,
		tokenResult.AccessToken,
	)
	if err != nil {
		return manager.failPending(loginID, err.Error())
	}

	now := time.Now()
	manager.mu.Lock()
	manager.credentialMap[cacheKey] = &awsSsoCredentialCacheEntry{
		UserID:             userID,
		Fingerprint:        manager.fingerprint(requestProfile),
		Request:            requestProfile,
		ClientID:           clientID,
		ClientSecret:       clientSecret,
		AccessToken:        tokenResult.AccessToken,
		AccessTokenExpires: now.Add(time.Duration(max(tokenResult.ExpiresIn, 60)) * time.Second),
		RefreshToken:       tokenResult.RefreshToken,
		Credential:         credential,
		CredentialExpires:  parseCredentialExpiry(credential.ExpiresAt, now),
		UpdatedAt:          now,
	}
	if pending := manager.pendingByID[loginID]; pending != nil {
		pending.ResolvedCredential = credential
		pending.ResolvedCredentialTime = parseCredentialExpiry(credential.ExpiresAt, now)
		pending.LastMessage = "ready"
	}
	manager.mu.Unlock()

	return awsSsoMobileHandoffResponse{
		LoginID:    loginID,
		Status:     "ready",
		Message:    "ready",
		Credential: credential,
		ExpiresAt:  credential.ExpiresAt,
	}, nil
}

func (manager *AwsSsoMobileManager) Cancel(userID string, loginID string) error {
	manager.mu.Lock()
	defer manager.mu.Unlock()

	pending := manager.pendingByID[loginID]
	if pending == nil || pending.UserID != userID {
		return errors.New("AWS SSO 로그인 상태를 찾지 못했습니다.")
	}
	pending.Cancelled = true
	pending.LastMessage = "AWS SSO 로그인이 취소되었습니다."
	return nil
}

func (manager *AwsSsoMobileManager) tryResolveCachedCredential(
	ctx context.Context,
	cacheKey string,
	request awsSsoMobileLoginStartRequest,
) (*awsTemporaryCredentialPayload, error) {
	manager.mu.Lock()
	cached := manager.credentialMap[cacheKey]
	manager.mu.Unlock()
	if cached == nil {
		return nil, nil
	}

	now := time.Now()
	if ready := manager.readyCredentialFromCacheEntry(cached, now); ready != nil {
		return ready, nil
	}

	if cached.AccessToken != "" && now.Add(awsSsoCredentialGrace).Before(cached.AccessTokenExpires) {
		credential, err := manager.getRoleCredential(
			ctx,
			request.SsoRegion,
			request.SsoAccountID,
			request.SsoRoleName,
			cached.AccessToken,
		)
		if err == nil {
			manager.mu.Lock()
			cached.Credential = credential
			cached.CredentialExpires = parseCredentialExpiry(credential.ExpiresAt, now)
			cached.UpdatedAt = now
			manager.mu.Unlock()
			return credential, nil
		}
	}

	if cached.RefreshToken == "" {
		return nil, errors.New("AWS SSO 로그인이 필요합니다.")
	}

	refreshed, err := manager.createRefreshToken(
		ctx,
		request.SsoRegion,
		cached.ClientID,
		cached.ClientSecret,
		cached.RefreshToken,
	)
	if err != nil {
		return nil, err
	}
	credential, err := manager.getRoleCredential(
		ctx,
		request.SsoRegion,
		request.SsoAccountID,
		request.SsoRoleName,
		refreshed.AccessToken,
	)
	if err != nil {
		return nil, err
	}

	manager.mu.Lock()
	cached.AccessToken = refreshed.AccessToken
	cached.AccessTokenExpires = now.Add(time.Duration(max(refreshed.ExpiresIn, 60)) * time.Second)
	if refreshed.RefreshToken != "" {
		cached.RefreshToken = refreshed.RefreshToken
	}
	cached.Credential = credential
	cached.CredentialExpires = parseCredentialExpiry(credential.ExpiresAt, now)
	cached.UpdatedAt = now
	manager.mu.Unlock()
	return credential, nil
}

func (manager *AwsSsoMobileManager) registerClient(
	ctx context.Context,
	request awsSsoMobileLoginStartRequest,
) (*awsSsoRegisterClientResponse, error) {
	args := []string{
		"sso-oidc",
		"register-client",
		"--region", request.SsoRegion,
		"--client-name", "Dolgate Mobile",
		"--client-type", "public",
		"--issuer-url", request.SsoStartURL,
		"--redirect-uris", request.RedirectURI,
		"--grant-types", awsSsoAuthorizationCodeGrantType, awsSsoRefreshTokenGrantType,
		"--scopes", awsSsoRegistrationScope,
	}
	var response awsSsoRegisterClientResponse
	if err := manager.runAWSJSON(ctx, args, &response); err != nil {
		return nil, err
	}
	if strings.TrimSpace(response.ClientID) == "" || strings.TrimSpace(response.ClientSecret) == "" {
		return nil, errors.New("AWS SSO client registration에 실패했습니다.")
	}
	return &response, nil
}

func (manager *AwsSsoMobileManager) createAuthorizationCodeToken(
	ctx context.Context,
	region string,
	clientID string,
	clientSecret string,
	code string,
	redirectURI string,
	codeVerifier string,
) (*awsSsoCreateTokenResponse, error) {
	args := []string{
		"sso-oidc",
		"create-token",
		"--region", region,
		"--client-id", clientID,
		"--client-secret", clientSecret,
		"--code", code,
		"--redirect-uri", redirectURI,
		"--code-verifier", codeVerifier,
		"--grant-type", awsSsoAuthorizationCodeGrantType,
	}
	var response awsSsoCreateTokenResponse
	if err := manager.runAWSJSON(ctx, args, &response); err != nil {
		return nil, err
	}
	return &response, nil
}

func (manager *AwsSsoMobileManager) createRefreshToken(
	ctx context.Context,
	region string,
	clientID string,
	clientSecret string,
	refreshToken string,
) (*awsSsoCreateTokenResponse, error) {
	args := []string{
		"sso-oidc",
		"create-token",
		"--region", region,
		"--client-id", clientID,
		"--client-secret", clientSecret,
		"--refresh-token", refreshToken,
		"--grant-type", awsSsoRefreshTokenGrantType,
	}
	var response awsSsoCreateTokenResponse
	if err := manager.runAWSJSON(ctx, args, &response); err != nil {
		return nil, err
	}
	return &response, nil
}

func (manager *AwsSsoMobileManager) getRoleCredential(
	ctx context.Context,
	region string,
	accountID string,
	roleName string,
	accessToken string,
) (*awsTemporaryCredentialPayload, error) {
	args := []string{
		"sso",
		"get-role-credentials",
		"--region", region,
		"--account-id", accountID,
		"--role-name", roleName,
		"--access-token", accessToken,
	}
	var response awsSsoGetRoleCredentialsResponse
	if err := manager.runAWSJSON(ctx, args, &response); err != nil {
		return nil, err
	}
	if response.RoleCredentials == nil ||
		strings.TrimSpace(response.RoleCredentials.AccessKeyID) == "" ||
		strings.TrimSpace(response.RoleCredentials.SecretAccessKey) == "" {
		return nil, errors.New("AWS SSO role credential을 가져오지 못했습니다.")
	}
	expiresAt := ""
	if response.RoleCredentials.Expiration > 0 {
		expiresAt = time.UnixMilli(response.RoleCredentials.Expiration).UTC().Format(time.RFC3339)
	}
	return &awsTemporaryCredentialPayload{
		AccessKeyID:     response.RoleCredentials.AccessKeyID,
		SecretAccessKey: response.RoleCredentials.SecretAccessKey,
		SessionToken:    response.RoleCredentials.SessionToken,
		ExpiresAt:       expiresAt,
	}, nil
}

func (manager *AwsSsoMobileManager) pendingResponseLocked(
	pending *awsSsoPendingLogin,
) awsSsoMobileHandoffResponse {
	switch {
	case pending == nil:
		return awsSsoMobileHandoffResponse{
			Status:  "error",
			Message: "AWS SSO 로그인 상태를 찾지 못했습니다.",
		}
	case pending.Cancelled:
		return awsSsoMobileHandoffResponse{
			LoginID:   pending.LoginID,
			Status:    "cancelled",
			ExpiresAt: pending.ExpiresAt.Format(time.RFC3339),
			Message:   "AWS SSO 로그인이 취소되었습니다.",
		}
	case time.Now().After(pending.ExpiresAt):
		return awsSsoMobileHandoffResponse{
			LoginID:   pending.LoginID,
			Status:    "expired",
			ExpiresAt: pending.ExpiresAt.Format(time.RFC3339),
			Message:   "AWS SSO 로그인 시간이 초과되었습니다.",
		}
	case pending.ResolvedCredential != nil && time.Now().Before(pending.ResolvedCredentialTime):
		return awsSsoMobileHandoffResponse{
			LoginID:    pending.LoginID,
			Status:     "ready",
			ExpiresAt:  pending.ExpiresAt.Format(time.RFC3339),
			Message:    "ready",
			Credential: pending.ResolvedCredential,
		}
	default:
		return awsSsoMobileHandoffResponse{
			LoginID:   pending.LoginID,
			Status:    "pending",
			ExpiresAt: pending.ExpiresAt.Format(time.RFC3339),
			Message:   pending.LastMessage,
		}
	}
}

func (manager *AwsSsoMobileManager) failPending(
	loginID string,
	message string,
) (awsSsoMobileHandoffResponse, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()

	pending := manager.pendingByID[loginID]
	if pending == nil {
		return awsSsoMobileHandoffResponse{}, errors.New("AWS SSO 로그인 상태를 찾지 못했습니다.")
	}
	return manager.failPendingLocked(pending, message), nil
}

func (manager *AwsSsoMobileManager) failPendingLocked(
	pending *awsSsoPendingLogin,
	message string,
) awsSsoMobileHandoffResponse {
	normalized := strings.TrimSpace(message)
	if normalized == "" {
		normalized = "AWS SSO 로그인을 완료하지 못했습니다."
	}
	pending.LastMessage = normalized
	return awsSsoMobileHandoffResponse{
		LoginID:   pending.LoginID,
		Status:    "error",
		ExpiresAt: pending.ExpiresAt.Format(time.RFC3339),
		Message:   normalized,
	}
}

func (manager *AwsSsoMobileManager) runAWSJSON(
	ctx context.Context,
	args []string,
	target any,
) error {
	commandContext, cancel := context.WithTimeout(ctx, awsCliTimeout)
	defer cancel()

	normalizedArgs := append([]string{}, args...)
	normalizedArgs = append(normalizedArgs, "--output", "json")
	command := exec.CommandContext(commandContext, manager.runtime.AWSPath, normalizedArgs...)
	output, err := command.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s", normalizeAwsCliError(string(output)))
	}
	if err := json.Unmarshal(output, target); err != nil {
		return fmt.Errorf("AWS CLI 응답을 해석하지 못했습니다: %w", err)
	}
	return nil
}

func (manager *AwsSsoMobileManager) cacheKey(
	userID string,
	request awsSsoMobileLoginStartRequest,
) string {
	return userID + "::" + manager.fingerprint(request)
}

func (manager *AwsSsoMobileManager) fingerprint(
	request awsSsoMobileLoginStartRequest,
) string {
	if strings.TrimSpace(request.SourceProfileFingerprint) != "" {
		return strings.TrimSpace(request.SourceProfileFingerprint)
	}
	payload := strings.Join([]string{
		strings.TrimSpace(request.SourceProfileName),
		strings.TrimSpace(strings.ToLower(request.SsoStartURL)),
		strings.TrimSpace(strings.ToLower(request.SsoRegion)),
		strings.TrimSpace(request.SsoAccountID),
		strings.TrimSpace(request.SsoRoleName),
	}, "::")
	sum := sha256.Sum256([]byte(payload))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func (manager *AwsSsoMobileManager) pruneLocked(now time.Time) {
	for loginID, pending := range manager.pendingByID {
		if pending == nil {
			delete(manager.pendingByID, loginID)
			continue
		}
		if now.After(pending.ExpiresAt.Add(time.Minute)) {
			delete(manager.pendingByID, loginID)
			delete(manager.pendingByKey, manager.cacheKey(pending.UserID, pending.Request))
		}
	}
	for cacheKey, cached := range manager.credentialMap {
		if cached == nil {
			delete(manager.credentialMap, cacheKey)
			continue
		}
		if cached.Credential == nil && cached.RefreshToken == "" && now.After(cached.AccessTokenExpires.Add(time.Minute)) {
			delete(manager.credentialMap, cacheKey)
			continue
		}
		if cached.Credential != nil && now.After(cached.CredentialExpires.Add(time.Minute)) && cached.RefreshToken == "" {
			delete(manager.credentialMap, cacheKey)
		}
	}
}

func (manager *AwsSsoMobileManager) readyCredentialFromCacheLocked(
	cached *awsSsoCredentialCacheEntry,
) *awsTemporaryCredentialPayload {
	return manager.readyCredentialFromCacheEntry(cached, time.Now())
}

func (manager *AwsSsoMobileManager) readyCredentialFromCacheEntry(
	cached *awsSsoCredentialCacheEntry,
	now time.Time,
) *awsTemporaryCredentialPayload {
	if cached == nil || cached.Credential == nil {
		return nil
	}
	if now.Add(awsSsoCredentialGrace).After(cached.CredentialExpires) {
		return nil
	}
	return cached.Credential
}

func validateLoopbackRedirectURI(raw string) error {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return errors.New("AWS SSO loopback redirect URI가 올바르지 않습니다.")
	}
	if parsed.Scheme != "http" || parsed.Hostname() != "127.0.0.1" || parsed.Port() == "" || parsed.Path != "/oauth/callback" {
		return errors.New("AWS SSO loopback redirect URI가 올바르지 않습니다.")
	}
	return nil
}

func buildAuthorizationURL(
	region string,
	clientID string,
	redirectURI string,
	state string,
	codeChallenge string,
) (string, error) {
	endpoint, err := url.Parse(fmt.Sprintf(awsSsoAuthorizeURLPattern, region))
	if err != nil {
		return "", err
	}
	query := endpoint.Query()
	query.Set("response_type", "code")
	query.Set("client_id", clientID)
	query.Set("redirect_uri", redirectURI)
	query.Set("state", state)
	query.Set("code_challenge_method", "S256")
	query.Set("code_challenge", codeChallenge)
	query.Set("scopes", awsSsoRegistrationScope)
	endpoint.RawQuery = query.Encode()
	return endpoint.String(), nil
}

func randomPKCEValue(byteCount int) (string, error) {
	buffer := make([]byte, byteCount)
	if _, err := rand.Read(buffer); err != nil {
		return "", fmt.Errorf("AWS SSO PKCE 값을 생성하지 못했습니다: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}

func normalizeAwsSsoCallbackError(request awsSsoMobileLoginHandoffRequest) string {
	if value := strings.TrimSpace(request.ErrorDescription); value != "" {
		return value
	}
	if value := strings.TrimSpace(request.Error); value != "" {
		return value
	}
	return "AWS SSO 로그인을 완료하지 못했습니다."
}

func parseCredentialExpiry(value string, fallback time.Time) time.Time {
	if strings.TrimSpace(value) == "" {
		return fallback.Add(15 * time.Minute)
	}
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return fallback.Add(15 * time.Minute)
	}
	return parsed
}

func normalizeAwsCliError(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "AWS 요청에 실패했습니다."
	}

	var parsed map[string]any
	if err := json.Unmarshal([]byte(trimmed), &parsed); err == nil {
		for _, key := range []string{"error_description", "error", "message", "Message", "__type"} {
			if value, ok := parsed[key].(string); ok && strings.TrimSpace(value) != "" {
				return strings.TrimSpace(value)
			}
		}
	}

	return trimmed
}

func max(left int32, right int32) int32 {
	if left > right {
		return left
	}
	return right
}

type awsSsoRegisterClientResponse struct {
	ClientID     string `json:"clientId"`
	ClientSecret string `json:"clientSecret"`
}

type awsTemporaryCredentialPayload struct {
	AccessKeyID     string `json:"accessKeyId"`
	SecretAccessKey string `json:"secretAccessKey"`
	SessionToken    string `json:"sessionToken,omitempty"`
	ExpiresAt       string `json:"expiresAt,omitempty"`
}

type awsSsoMobileLoginStartRequest struct {
	TargetProfileName        string `json:"targetProfileName"`
	SourceProfileName        string `json:"sourceProfileName"`
	SourceProfileFingerprint string `json:"sourceProfileFingerprint"`
	SsoStartURL              string `json:"ssoStartUrl"`
	SsoRegion                string `json:"ssoRegion"`
	SsoAccountID             string `json:"ssoAccountId"`
	SsoRoleName              string `json:"ssoRoleName"`
	RedirectURI              string `json:"redirectUri"`
}

type awsSsoMobileLoginHandoffRequest struct {
	Code             string `json:"code"`
	State            string `json:"state"`
	Error            string `json:"error"`
	ErrorDescription string `json:"errorDescription"`
}

type awsSsoMobileLoginStartResponse struct {
	LoginID    string                         `json:"loginId"`
	Status     string                         `json:"status"`
	BrowserURL string                         `json:"browserUrl,omitempty"`
	ExpiresAt  string                         `json:"expiresAt,omitempty"`
	Message    string                         `json:"message,omitempty"`
	Credential *awsTemporaryCredentialPayload `json:"credential,omitempty"`
}

type awsSsoMobileHandoffResponse struct {
	LoginID    string                         `json:"loginId"`
	Status     string                         `json:"status"`
	ExpiresAt  string                         `json:"expiresAt,omitempty"`
	Message    string                         `json:"message,omitempty"`
	Credential *awsTemporaryCredentialPayload `json:"credential,omitempty"`
}

type awsSsoCreateTokenResponse struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
	ExpiresIn    int32  `json:"expiresIn"`
}

type awsSsoGetRoleCredentialsResponse struct {
	RoleCredentials *struct {
		AccessKeyID     string `json:"accessKeyId"`
		SecretAccessKey string `json:"secretAccessKey"`
		SessionToken    string `json:"sessionToken"`
		Expiration      int64  `json:"expiration"`
	} `json:"roleCredentials"`
}
