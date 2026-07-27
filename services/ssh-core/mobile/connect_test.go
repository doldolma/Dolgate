package mobile

import (
	"encoding/json"
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/sshconn"
	"dolssh/services/ssh-core/mobile/internal/sshtest"
	"dolssh/services/ssh-core/pkg/coretypes"
)

// requestJSON renders a connect payload the way the app does: flat, with an id.
func requestJSON(t *testing.T, payload coretypes.ConnectPayload) string {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("encode payload: %v", err)
	}
	var fields map[string]any
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	fields["id"] = "conn-1"
	out, err := json.Marshal(fields)
	if err != nil {
		t.Fatalf("encode request: %v", err)
	}
	return string(out)
}

type probedKey struct {
	Algorithm         string `json:"algorithm"`
	PublicKeyBase64   string `json:"publicKeyBase64"`
	FingerprintSHA256 string `json:"fingerprintSha256"`
}

func TestProbeHostKeyReportsServerKey(t *testing.T) {
	server := newTestServer(t)

	// A probe must work without any trusted key configured; that is the whole
	// point of it, since the app has nothing to trust yet.
	payload := server.ConnectPayload()
	payload.TrustedHostKeyBase64 = ""
	payload.Password = ""

	raw, err := NewEngine().ProbeHostKey(requestJSON(t, payload))
	if err != nil {
		t.Fatalf("probe: %v", err)
	}

	var key probedKey
	if err := json.Unmarshal([]byte(raw), &key); err != nil {
		t.Fatalf("decode probe result: %v", err)
	}
	if key.PublicKeyBase64 != server.HostKeyBase64() {
		t.Errorf("probed key = %q, want the fixture's host key", key.PublicKeyBase64)
	}
	if key.Algorithm == "" {
		t.Error("probe did not report an algorithm")
	}
	if key.FingerprintSHA256 == "" {
		t.Error("probe did not report a fingerprint")
	}
}

// The flow the app performs for an unknown host: probe, show the key to the
// user, then connect trusting exactly what was accepted.
func TestProbeThenConnectWithAcceptedKey(t *testing.T) {
	server := newTestServer(t)

	probePayload := server.ConnectPayload()
	probePayload.TrustedHostKeyBase64 = ""

	raw, err := NewEngine().ProbeHostKey(requestJSON(t, probePayload))
	if err != nil {
		t.Fatalf("probe: %v", err)
	}
	var key probedKey
	if err := json.Unmarshal([]byte(raw), &key); err != nil {
		t.Fatalf("decode probe result: %v", err)
	}

	connectPayload := server.ConnectPayload()
	connectPayload.TrustedHostKeyBase64 = key.PublicKeyBase64

	conn, err := NewEngine().Connect(requestJSON(t, connectPayload), nil, nil)
	if err != nil {
		t.Fatalf("connect with the probed key: %v", err)
	}
	defer conn.Close()

	shell, err := conn.StartShell(`{"term":"xterm-256color"}`, nil)
	if err != nil {
		t.Fatalf("start shell: %v", err)
	}
	defer shell.Close()

	if err := shell.SendData([]byte("after-trust\n")); err != nil {
		t.Fatalf("send: %v", err)
	}
	waitForRead(t, shell, "after-trust\n")
}

func TestProbeHostKeyRejectsMalformedRequest(t *testing.T) {
	if _, err := NewEngine().ProbeHostKey("{not json"); err == nil {
		t.Error("expected an error for malformed JSON")
	}
}

func TestProbeHostKeyReportsUnreachableHost(t *testing.T) {
	payload := coretypes.ConnectPayload{
		Host:     "127.0.0.1",
		Port:     1, // nothing listens here
		Username: sshtest.User,
	}
	engine := NewEngine()
	request := requestJSON(t, payload)

	// Keep the failure quick rather than waiting out the default dial timeout.
	var withTimeout map[string]any
	if err := json.Unmarshal([]byte(request), &withTimeout); err != nil {
		t.Fatalf("decode request: %v", err)
	}
	withTimeout["dialTimeoutMs"] = 500
	encoded, err := json.Marshal(withTimeout)
	if err != nil {
		t.Fatalf("encode request: %v", err)
	}

	if _, err := engine.ProbeHostKey(string(encoded)); err == nil {
		t.Error("expected a probe against a closed port to fail")
	}
}

func TestInspectPrivateKeyReportsAlgorithmAndFingerprint(t *testing.T) {
	generated, err := sshconn.GeneratePrivateKey(sshconn.PrivateKeyGenerationRequest{
		Algorithm: "ed25519",
		Comment:   "engine-test",
	})
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}

	raw, err := NewEngine().InspectPrivateKey(generated.PrivateKeyPEM, "")
	if err != nil {
		t.Fatalf("inspect: %v", err)
	}

	var inspection struct {
		Algorithm         string `json:"algorithm"`
		PublicKey         string `json:"publicKey"`
		FingerprintSHA256 string `json:"fingerprintSha256"`
	}
	if err := json.Unmarshal([]byte(raw), &inspection); err != nil {
		t.Fatalf("decode inspection: %v", err)
	}
	if inspection.Algorithm == "" || inspection.PublicKey == "" || inspection.FingerprintSHA256 == "" {
		t.Errorf("inspection is incomplete: %+v", inspection)
	}
	if inspection.FingerprintSHA256 != generated.FingerprintSHA256 {
		t.Errorf("fingerprint = %q, want %q", inspection.FingerprintSHA256, generated.FingerprintSHA256)
	}
}

func TestInspectPrivateKeyRejectsGarbage(t *testing.T) {
	if _, err := NewEngine().InspectPrivateKey("not a key", ""); err == nil {
		t.Error("expected an error for an unparseable private key")
	}
}

func TestInspectCertificateReportsStatus(t *testing.T) {
	raw, err := NewEngine().InspectCertificate("not a certificate")
	if err != nil {
		t.Fatalf("inspect: %v", err)
	}
	var inspection struct {
		Status string `json:"status"`
	}
	if err := json.Unmarshal([]byte(raw), &inspection); err != nil {
		t.Fatalf("decode inspection: %v", err)
	}
	if inspection.Status == "" {
		t.Error("certificate inspection did not report a status")
	}
}

type disconnectRecorder struct {
	fired chan string
}

func (d *disconnectRecorder) OnDisconnected(connectionID string) {
	d.fired <- connectionID
}

// A dropped network is the case nothing else can detect: no disconnect message
// arrives, so only the transport watcher notices.
func TestDisconnectedCallbackFiresOnTransportLoss(t *testing.T) {
	server := newTestServer(t)
	recorder := &disconnectRecorder{fired: make(chan string, 4)}

	conn, err := NewEngine().Connect(connectJSON(t, server, 30, 100), nil, recorder)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer conn.Close()

	shell, err := conn.StartShell(`{"term":"xterm-256color"}`, nil)
	if err != nil {
		t.Fatalf("start shell: %v", err)
	}

	server.DropConnections()

	select {
	case id := <-recorder.fired:
		if id != "conn-1" {
			t.Errorf("callback reported connection %q, want conn-1", id)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("OnDisconnected never fired after the transport was dropped")
	}

	// The shell must go with it, so writes fail instead of vanishing silently.
	deadline := time.Now().Add(5 * time.Second)
	for {
		if err := shell.SendData([]byte("x\n")); err != nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("writes still appeared to succeed after the transport was dropped")
		}
		time.Sleep(10 * time.Millisecond)
	}

	// A listener attached after the drop must terminate rather than wait forever
	// on a feed that will never produce anything.
	settled := make(chan struct{})
	go func() {
		defer close(settled)
		shell.RemoveListener(shell.AddListener(&recordingListener{}, CursorLive, 0, 0, 0, 1))
	}()
	select {
	case <-settled:
	case <-time.After(5 * time.Second):
		t.Fatal("a listener attached after the drop did not terminate")
	}
}

func TestDisconnectedCallbackSuppressedOnExplicitClose(t *testing.T) {
	server := newTestServer(t)
	recorder := &disconnectRecorder{fired: make(chan string, 4)}

	conn, err := NewEngine().Connect(connectJSON(t, server, 30, 100), nil, recorder)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}

	if err := conn.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	select {
	case id := <-recorder.fired:
		t.Errorf("OnDisconnected fired for an app-initiated close (connection %q)", id)
	case <-time.After(500 * time.Millisecond):
	}
}
