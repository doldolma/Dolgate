package auth

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"dolssh/services/sync-api/internal/store"
)

func TestDeriveWebAuthnRP(t *testing.T) {
	cases := []struct {
		name        string
		publicBase  string
		rpID        string
		origins     []string
		wantOK      bool
		wantRPID    string
		wantOrigins []string
	}{
		{name: "https domain", publicBase: "https://ssh.doldolma.com", wantOK: true, wantRPID: "ssh.doldolma.com", wantOrigins: []string{"https://ssh.doldolma.com"}},
		{name: "https with port", publicBase: "https://sync.example.com:8443", wantOK: true, wantRPID: "sync.example.com", wantOrigins: []string{"https://sync.example.com:8443"}},
		{name: "uppercase host normalized", publicBase: "https://SSH.Example.COM", wantOK: true, wantRPID: "ssh.example.com", wantOrigins: []string{"https://ssh.example.com"}},
		{name: "trailing dot fqdn normalized", publicBase: "https://ssh.example.com.", wantOK: true, wantRPID: "ssh.example.com", wantOrigins: []string{"https://ssh.example.com"}},
		{name: "http localhost ok", publicBase: "http://localhost:8080", wantOK: true, wantRPID: "localhost", wantOrigins: []string{"http://localhost:8080"}},
		{name: "http 127.0.0.1 rejected (ip)", publicBase: "http://127.0.0.1:8080", wantOK: false},
		{name: "https ip rejected", publicBase: "https://192.168.0.10", wantOK: false},
		{name: "http remote domain rejected", publicBase: "http://homelab.lan:8080", wantOK: false},
		{name: "empty rejected", publicBase: "", wantOK: false},
		{name: "explicit overrides win", publicBase: "http://192.168.0.10", rpID: "keys.example.com", origins: []string{"https://keys.example.com"}, wantOK: true, wantRPID: "keys.example.com", wantOrigins: []string{"https://keys.example.com"}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			rpID, origins, ok, reason := DeriveWebAuthnRP(testCase.publicBase, testCase.rpID, testCase.origins)
			if ok != testCase.wantOK {
				t.Fatalf("ok = %v (reason=%q), want %v", ok, reason, testCase.wantOK)
			}
			if !testCase.wantOK {
				return
			}
			if rpID != testCase.wantRPID {
				t.Fatalf("rpID = %q, want %q", rpID, testCase.wantRPID)
			}
			if len(origins) != len(testCase.wantOrigins) || origins[0] != testCase.wantOrigins[0] {
				t.Fatalf("origins = %v, want %v", origins, testCase.wantOrigins)
			}
		})
	}
}

func TestWebAuthnRegisterTicketRoundTrip(t *testing.T) {
	service, _ := newTestService(t)
	ctx := context.Background()

	ticket, err := service.NewWebAuthnRegisterTicket(ctx, "user-123")
	if err != nil {
		t.Fatalf("NewWebAuthnRegisterTicket() error = %v", err)
	}
	userID, ticketID, err := service.ParseWebAuthnRegisterTicket(ticket)
	if err != nil {
		t.Fatalf("ParseWebAuthnRegisterTicket() error = %v", err)
	}
	if userID != "user-123" {
		t.Fatalf("userID = %q, want user-123", userID)
	}
	if ticketID == "" {
		t.Fatalf("ticketID must not be empty")
	}
}

// 티켓은 소지만으로 남의 계정에 패스키를 붙일 수 있으므로 한 번만 쓰여야 한다.
func TestWebAuthnRegisterTicketIsSingleUse(t *testing.T) {
	service, _ := newTestService(t)
	ctx := context.Background()

	ticket, err := service.NewWebAuthnRegisterTicket(ctx, "user-1")
	if err != nil {
		t.Fatalf("NewWebAuthnRegisterTicket() error = %v", err)
	}
	_, ticketID, err := service.ParseWebAuthnRegisterTicket(ticket)
	if err != nil {
		t.Fatalf("ParseWebAuthnRegisterTicket() error = %v", err)
	}

	if err := service.ConsumeWebAuthnRegisterTicket(ctx, "user-1", ticketID); err != nil {
		t.Fatalf("첫 소비 error = %v", err)
	}
	// 서명은 여전히 유효하지만(만료 전) 표식이 사라져 두 번째는 막힌다.
	if _, _, err := service.ParseWebAuthnRegisterTicket(ticket); err != nil {
		t.Fatalf("서명 자체는 유효해야 한다: %v", err)
	}
	if err := service.ConsumeWebAuthnRegisterTicket(ctx, "user-1", ticketID); err == nil {
		t.Fatalf("두 번째 소비는 실패해야 한다")
	}
}

// 남의 티켓을 자기 userID 로 소비할 수 없어야 한다.
func TestWebAuthnRegisterTicketRejectsOtherUser(t *testing.T) {
	service, _ := newTestService(t)
	ctx := context.Background()

	ticket, err := service.NewWebAuthnRegisterTicket(ctx, "victim")
	if err != nil {
		t.Fatalf("NewWebAuthnRegisterTicket() error = %v", err)
	}
	_, ticketID, _ := service.ParseWebAuthnRegisterTicket(ticket)
	if err := service.ConsumeWebAuthnRegisterTicket(ctx, "attacker", ticketID); err == nil {
		t.Fatalf("다른 사용자의 티켓 소비가 통과했다")
	}
}

// 같은 서명 키를 공유하므로, 등록 티켓과 access token 이 서로의 파서를 통과하면 안 된다.
func TestWebAuthnTicketAndAccessTokenAreNotInterchangeable(t *testing.T) {
	service, _ := newTestService(t)

	ticket, err := service.NewWebAuthnRegisterTicket(context.Background(), "user-1")
	if err != nil {
		t.Fatalf("NewWebAuthnRegisterTicket() error = %v", err)
	}
	if _, err := service.ParseAccessToken(ticket); err == nil {
		t.Fatalf("access token parser must reject a register ticket")
	}

	accessToken, err := service.signAccessToken(store.User{ID: "user-1", Email: "a@example.com"})
	if err != nil {
		t.Fatalf("signAccessToken() error = %v", err)
	}
	if _, _, err := service.ParseWebAuthnRegisterTicket(accessToken); err == nil {
		t.Fatalf("ticket parser must reject an access token")
	}
}

func TestNewWebAuthnServiceValidatesConfig(t *testing.T) {
	_, backingStore := newTestService(t)

	if _, err := NewWebAuthnService(backingStore, "", "Dolgate", []string{"https://x.example.com"}); err == nil {
		t.Fatalf("expected error for empty rp id")
	}
	if _, err := NewWebAuthnService(backingStore, "x.example.com", "Dolgate", nil); err == nil {
		t.Fatalf("expected error for empty origins")
	}
	if _, err := NewWebAuthnService(backingStore, "x.example.com", "Dolgate", []string{"https://x.example.com"}); err != nil {
		t.Fatalf("NewWebAuthnService() error = %v", err)
	}
}

// 상한이 없으면 티켓 하나로 패스키를 무한정 붙일 수 있다. 생체인증을 시키기 전(begin)에
// 거절해야 사용자가 헛수고하지 않는다.
func TestWebAuthnRegistrationRespectsCredentialCap(t *testing.T) {
	_, backingStore := newTestService(t)
	ctx := context.Background()

	user, err := backingStore.CreateUser(ctx, "capped@example.com", "")
	if err != nil {
		t.Fatalf("CreateUser() error = %v", err)
	}
	service, err := NewWebAuthnService(backingStore, "x.example.com", "Dolgate", []string{"https://x.example.com"})
	if err != nil {
		t.Fatalf("NewWebAuthnService() error = %v", err)
	}

	// 상한 직전까지는 시작할 수 있어야 한다.
	for i := 0; i < MaxWebAuthnCredentialsPerUser-1; i++ {
		if err := backingStore.SaveWebAuthnCredential(ctx, store.WebAuthnCredential{
			CredentialID: fmt.Sprintf("cred-%d", i), UserID: user.ID, Data: []byte(`{}`),
		}); err != nil {
			t.Fatalf("SaveWebAuthnCredential(%d) error = %v", i, err)
		}
	}
	if _, _, err := service.BeginRegistration(ctx, user.ID); err != nil {
		t.Fatalf("상한 직전 BeginRegistration error = %v", err)
	}

	if err := backingStore.SaveWebAuthnCredential(ctx, store.WebAuthnCredential{
		CredentialID: "cred-last", UserID: user.ID, Data: []byte(`{}`),
	}); err != nil {
		t.Fatalf("SaveWebAuthnCredential(last) error = %v", err)
	}
	if _, _, err := service.BeginRegistration(ctx, user.ID); !errors.Is(err, ErrTooManyWebAuthnCredentials) {
		t.Fatalf("BeginRegistration error = %v, want ErrTooManyWebAuthnCredentials", err)
	}
}
