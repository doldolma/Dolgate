package auth

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
	"gorm.io/gorm"

	"dolssh/services/sync-api/internal/store"
)

// WebAuthn ceremony(begin↔finish)를 잇는 일회성 상태의 수명. 짧게 유지해 미소비 챌린지가
// 오래 남지 않게 한다.
const webauthnCeremonyTTL = 5 * time.Minute

const (
	webauthnPurposeRegister = "register"
	webauthnPurposeLogin    = "login"
)

var ErrWebAuthnCeremony = errors.New("invalid or expired webauthn ceremony")

// ErrUnknownWebAuthnCredential 는 discoverable 로그인에서 어써션의 자격증명이 이 서버에
// 기록이 없을 때 반환한다 — (1) user handle 로 사용자를 못 찾거나, (2) 사용자는 있으나 그
// 자격증명이 목록에 없는 경우. 두 경우 모두 "서버에 없는(unknown) 자격증명"이라, 클라이언트가
// signalUnknownCredential 로 비밀번호 관리자의 stale 패스키를 안전하게 정리할 수 있다.
// 서명 검증 실패는 여기에 포함하지 않는다 — 기록은 있으나 검증만 실패한 것이라(서버측 공개키
// 불일치·클론 감지 등) 정상 패스키를 지울 위험이 있어 별개로 다룬다.
var ErrUnknownWebAuthnCredential = errors.New("webauthn credential is not registered")

// WebAuthnService 는 브라우저 로그인의 패스키 등록/인증 ceremony 를 처리한다. 자격증명은
// go-webauthn 의 Credential 을 JSON 으로 마샬링해 store 에 불투명 바이트로 보관한다 — store 는
// WebAuthn 라이브러리에 의존하지 않는다.
type WebAuthnService struct {
	webauthn *webauthn.WebAuthn
	store    store.Store
	rpID     string
	origins  []string
}

// RPID/Origins 게터 — 라우터가 capability/로그 노출에 사용한다.
func (s *WebAuthnService) RPID() string      { return s.rpID }
func (s *WebAuthnService) Origins() []string { return s.origins }

func NewWebAuthnService(dataStore store.Store, rpID string, rpDisplayName string, origins []string) (*WebAuthnService, error) {
	if strings.TrimSpace(rpID) == "" {
		return nil, errors.New("webauthn rp id is required")
	}
	if len(origins) == 0 {
		return nil, errors.New("webauthn rp origins are required")
	}
	if strings.TrimSpace(rpDisplayName) == "" {
		rpDisplayName = rpID
	}
	instance, err := webauthn.New(&webauthn.Config{
		RPID:          rpID,
		RPDisplayName: rpDisplayName,
		RPOrigins:     origins,
		// 패스키(discoverable) 로그인을 위해 resident key 를 요구한다 — 이메일 입력 없이
		// "패스키로 로그인"이 가능해진다. UV 는 preferred(생체/PIN 있으면 사용, 없어도 진행).
		AuthenticatorSelection: protocol.AuthenticatorSelection{
			ResidentKey:      protocol.ResidentKeyRequirementRequired,
			UserVerification: protocol.VerificationPreferred,
		},
	})
	if err != nil {
		return nil, err
	}
	return &WebAuthnService{
		webauthn: instance,
		store:    dataStore,
		rpID:     rpID,
		origins:  origins,
	}, nil
}

// webauthnUser 는 store.User + 그 사용자의 자격증명을 go-webauthn 의 User 인터페이스로 어댑팅한다.
// WebAuthnID 는 user.ID(UUID) 바이트로, discoverable 로그인의 user handle 로 되돌아온다.
type webauthnUser struct {
	user        store.User
	credentials []webauthn.Credential
}

func (u *webauthnUser) WebAuthnID() []byte                         { return []byte(u.user.ID) }
func (u *webauthnUser) WebAuthnName() string                       { return u.user.Email }
func (u *webauthnUser) WebAuthnDisplayName() string                { return u.user.Email }
func (u *webauthnUser) WebAuthnCredentials() []webauthn.Credential { return u.credentials }

func (s *WebAuthnService) loadUser(ctx context.Context, userID string) (*webauthnUser, error) {
	user, err := s.store.GetUserByID(ctx, userID)
	if err != nil {
		return nil, err
	}
	credentials, err := s.loadCredentials(ctx, userID)
	if err != nil {
		return nil, err
	}
	return &webauthnUser{user: user, credentials: credentials}, nil
}

func (s *WebAuthnService) loadCredentials(ctx context.Context, userID string) ([]webauthn.Credential, error) {
	rows, err := s.store.ListWebAuthnCredentialsByUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	credentials := make([]webauthn.Credential, 0, len(rows))
	for _, row := range rows {
		var credential webauthn.Credential
		if err := json.Unmarshal(row.Data, &credential); err != nil {
			return nil, fmt.Errorf("decode stored webauthn credential: %w", err)
		}
		credentials = append(credentials, credential)
	}
	return credentials, nil
}

func webauthnCredentialID(raw []byte) string {
	return base64.RawURLEncoding.EncodeToString(raw)
}

// BeginRegistration 은 로그인된 사용자가 새 패스키를 등록하는 ceremony 를 시작한다.
func (s *WebAuthnService) BeginRegistration(ctx context.Context, userID string) (*protocol.CredentialCreation, string, error) {
	user, err := s.loadUser(ctx, userID)
	if err != nil {
		return nil, "", err
	}
	exclusions := make([]protocol.CredentialDescriptor, 0, len(user.credentials))
	for i := range user.credentials {
		exclusions = append(exclusions, user.credentials[i].Descriptor())
	}
	creation, session, err := s.webauthn.BeginRegistration(user, webauthn.WithExclusions(exclusions))
	if err != nil {
		return nil, "", err
	}
	ceremonyID, err := s.saveCeremony(ctx, webauthnPurposeRegister, userID, session)
	if err != nil {
		return nil, "", err
	}
	return creation, ceremonyID, nil
}

// FinishRegistration 은 authenticator 응답을 검증하고 자격증명을 저장한다.
func (s *WebAuthnService) FinishRegistration(ctx context.Context, userID string, ceremonyID string, name string, responseBody []byte) error {
	session, err := s.consumeCeremony(ctx, ceremonyID, webauthnPurposeRegister, userID)
	if err != nil {
		return err
	}
	parsed, err := protocol.ParseCredentialCreationResponseBody(bytes.NewReader(responseBody))
	if err != nil {
		return err
	}
	user, err := s.loadUser(ctx, userID)
	if err != nil {
		return err
	}
	credential, err := s.webauthn.CreateCredential(user, *session, parsed)
	if err != nil {
		return err
	}
	data, err := json.Marshal(credential)
	if err != nil {
		return err
	}
	return s.store.SaveWebAuthnCredential(ctx, store.WebAuthnCredential{
		CredentialID: webauthnCredentialID(credential.ID),
		UserID:       userID,
		Name:         strings.TrimSpace(name),
		Data:         data,
	})
}

// BeginLogin 은 discoverable(usernameless) 패스키 로그인 ceremony 를 시작한다.
func (s *WebAuthnService) BeginLogin(ctx context.Context) (*protocol.CredentialAssertion, string, error) {
	assertion, session, err := s.webauthn.BeginDiscoverableLogin()
	if err != nil {
		return nil, "", err
	}
	ceremonyID, err := s.saveCeremony(ctx, webauthnPurposeLogin, "", session)
	if err != nil {
		return nil, "", err
	}
	return assertion, ceremonyID, nil
}

// FinishLogin 은 어써션을 검증하고 인증된 사용자를 돌려준다. user handle 로 사용자를 찾고,
// 검증 성공 시 갱신된 sign count 를 저장한다.
func (s *WebAuthnService) FinishLogin(ctx context.Context, ceremonyID string, responseBody []byte) (store.User, error) {
	session, err := s.consumeCeremony(ctx, ceremonyID, webauthnPurposeLogin, "")
	if err != nil {
		return store.User{}, err
	}
	parsed, err := protocol.ParseCredentialRequestResponseBody(bytes.NewReader(responseBody))
	if err != nil {
		return store.User{}, err
	}

	var resolved store.User
	unknownCredential := false
	handler := func(rawID []byte, userHandle []byte) (webauthn.User, error) {
		user, loadErr := s.loadUser(ctx, string(userHandle))
		if loadErr != nil {
			// (1) user handle 로 사용자를 못 찾음 = 이 서버에 없는 계정의 자격증명(예: DB 재생성).
			if errors.Is(loadErr, gorm.ErrRecordNotFound) {
				unknownCredential = true
			}
			return nil, loadErr
		}
		resolved = user.user
		// (2) 사용자는 있으나 이 자격증명이 목록에 없음 = 서버에서 삭제됐는데 인증기에만 남은 것.
		// 서명 검증(아래 ValidateDiscoverableLogin) 이전 단계라, 여기서 세운 플래그는 "기록 없음"만
		// 뜻하고 서명 실패와 섞이지 않는다.
		hasCredential := false
		for i := range user.credentials {
			if bytes.Equal(user.credentials[i].ID, rawID) {
				hasCredential = true
				break
			}
		}
		if !hasCredential {
			unknownCredential = true
		}
		return user, nil
	}

	credential, err := s.webauthn.ValidateDiscoverableLogin(handler, *session, parsed)
	if err != nil {
		// 서버에 기록이 없는 경우에만 미등록으로 확정한다(서명 검증 실패는 제외).
		if unknownCredential {
			return store.User{}, ErrUnknownWebAuthnCredential
		}
		return store.User{}, err
	}
	if resolved.ID == "" {
		return store.User{}, ErrInvalidCredentials
	}

	// sign count 등 갱신된 자격증명을 되저장한다(클론 감지의 근거). 실패해도 로그인 자체는
	// 성공으로 처리하되 상위에서 로깅하도록 에러는 무시하지 않고 반환하지 않는다.
	if data, marshalErr := json.Marshal(credential); marshalErr == nil {
		_ = s.store.UpdateWebAuthnCredentialData(ctx, webauthnCredentialID(credential.ID), data, time.Now().UTC())
	}
	return resolved, nil
}

func (s *WebAuthnService) saveCeremony(ctx context.Context, purpose string, userID string, session *webauthn.SessionData) (string, error) {
	sessionData, err := json.Marshal(session)
	if err != nil {
		return "", err
	}
	ceremonyID, err := randomToken()
	if err != nil {
		return "", err
	}
	if err := s.store.SaveWebAuthnCeremony(ctx, store.WebAuthnCeremony{
		ID:          ceremonyID,
		UserID:      userID,
		Purpose:     purpose,
		SessionData: sessionData,
		ExpiresAt:   time.Now().Add(webauthnCeremonyTTL),
	}); err != nil {
		return "", err
	}
	return ceremonyID, nil
}

func (s *WebAuthnService) consumeCeremony(ctx context.Context, ceremonyID string, purpose string, userID string) (*webauthn.SessionData, error) {
	if strings.TrimSpace(ceremonyID) == "" {
		return nil, ErrWebAuthnCeremony
	}
	record, err := s.store.ConsumeWebAuthnCeremony(ctx, ceremonyID)
	if err != nil {
		return nil, ErrWebAuthnCeremony
	}
	if record.Purpose != purpose || time.Now().After(record.ExpiresAt) {
		return nil, ErrWebAuthnCeremony
	}
	if userID != "" && record.UserID != userID {
		return nil, ErrWebAuthnCeremony
	}
	var session webauthn.SessionData
	if err := json.Unmarshal(record.SessionData, &session); err != nil {
		return nil, ErrWebAuthnCeremony
	}
	return &session, nil
}

// DeriveWebAuthnRP 는 설정값(명시 RPID/Origins 우선)과 PublicBaseURL 로부터 RP ID 와 origin 을
// 유도한다. WebAuthn 규격상 secure context(https, 또는 loopback localhost) 이면서 IP 리터럴이
// 아닌 도메인이어야 하므로, 그 조건을 만족하지 못하면 ok=false 와 사유를 돌려준다 — 호출 측은
// 이때 WebAuthn 을 자동 비활성한다.
func DeriveWebAuthnRP(publicBaseURL string, configuredRPID string, configuredOrigins []string) (rpID string, origins []string, ok bool, reason string) {
	rpID = strings.TrimSpace(configuredRPID)
	origins = configuredOrigins
	if rpID != "" && len(origins) > 0 {
		return rpID, origins, true, ""
	}

	base := strings.TrimSpace(publicBaseURL)
	if base == "" {
		return "", nil, false, "PUBLIC_BASE_URL이 설정되지 않아 RP ID를 유도할 수 없습니다"
	}
	parsed, err := url.Parse(base)
	if err != nil || parsed.Host == "" {
		return "", nil, false, fmt.Sprintf("PUBLIC_BASE_URL(%q)을 해석할 수 없습니다", base)
	}
	// 브라우저는 RP ID·origin 을 소문자 등록 도메인으로 정규화하므로 서버도 맞춘다. 안 그러면
	// 대문자 PUBLIC_BASE_URL 에서 sha256(rpID) 불일치·origin 비교 실패로 조용히 전부 깨진다.
	host := strings.ToLower(strings.TrimSuffix(parsed.Hostname(), "."))
	isLoopbackName := host == "localhost" || strings.HasSuffix(host, ".localhost")
	switch {
	case parsed.Scheme == "https":
	case parsed.Scheme == "http" && isLoopbackName:
	default:
		return "", nil, false, fmt.Sprintf("origin(%q)이 https 도메인이 아니라 WebAuthn을 쓸 수 없습니다", base)
	}
	if net.ParseIP(host) != nil {
		return "", nil, false, fmt.Sprintf("origin 호스트(%q)가 IP 주소라 RP ID로 쓸 수 없습니다", host)
	}
	if rpID == "" {
		rpID = host
	}
	if len(origins) == 0 {
		// parsed.Host 대신 정규화한 host 로 origin 을 조립한다(대소문자 일치 보장).
		origin := parsed.Scheme + "://" + host
		if port := parsed.Port(); port != "" {
			origin += ":" + port
		}
		origins = []string{origin}
	}
	return rpID, origins, true, ""
}
