package auth

import (
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

	ticket, err := service.NewWebAuthnRegisterTicket("user-123")
	if err != nil {
		t.Fatalf("NewWebAuthnRegisterTicket() error = %v", err)
	}
	userID, err := service.ParseWebAuthnRegisterTicket(ticket)
	if err != nil {
		t.Fatalf("ParseWebAuthnRegisterTicket() error = %v", err)
	}
	if userID != "user-123" {
		t.Fatalf("userID = %q, want user-123", userID)
	}
}

// 같은 서명 키를 공유하므로, 등록 티켓과 access token 이 서로의 파서를 통과하면 안 된다.
func TestWebAuthnTicketAndAccessTokenAreNotInterchangeable(t *testing.T) {
	service, _ := newTestService(t)

	ticket, err := service.NewWebAuthnRegisterTicket("user-1")
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
	if _, err := service.ParseWebAuthnRegisterTicket(accessToken); err == nil {
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
