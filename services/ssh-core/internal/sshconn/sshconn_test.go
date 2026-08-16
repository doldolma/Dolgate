package sshconn

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"net"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"dolssh/services/ssh-core/pkg/coretypes"
)

func generateTestKeyPair(t *testing.T) (ssh.Signer, []byte) {
	t.Helper()

	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("rsa.GenerateKey() error = %v", err)
	}

	signer, err := ssh.NewSignerFromKey(privateKey)
	if err != nil {
		t.Fatalf("ssh.NewSignerFromKey() error = %v", err)
	}

	privateKeyPEM := pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PRIVATE KEY",
		Bytes: x509.MarshalPKCS1PrivateKey(privateKey),
	})

	return signer, privateKeyPEM
}

func generateTestCertificate(
	t *testing.T,
	userSigner ssh.Signer,
	options ...func(*ssh.Certificate),
) string {
	t.Helper()

	caSigner, _ := generateTestKeyPair(t)
	cert := &ssh.Certificate{
		Key:             userSigner.PublicKey(),
		Serial:          1,
		CertType:        ssh.UserCert,
		ValidPrincipals: []string{"test-user"},
		ValidBefore:     ssh.CertTimeInfinity,
	}
	for _, option := range options {
		option(cert)
	}
	if err := cert.SignCert(rand.Reader, caSigner); err != nil {
		t.Fatalf("cert.SignCert() error = %v", err)
	}
	return string(ssh.MarshalAuthorizedKey(cert))
}

func TestStrictHostKeyCallback(t *testing.T) {
	trustedSigner, _ := generateTestKeyPair(t)
	untrustedSigner, _ := generateTestKeyPair(t)

	callback, err := hostKeyCallbackFor(
		Target{TrustedHostKeyBase64: base64.StdEncoding.EncodeToString(trustedSigner.PublicKey().Marshal())},
		nil,
	)
	if err != nil {
		t.Fatalf("hostKeyCallbackFor() error = %v", err)
	}

	if err := callback("example.com", &net.TCPAddr{}, trustedSigner.PublicKey()); err != nil {
		t.Fatalf("callback() error = %v, want nil", err)
	}

	if err := callback("example.com", &net.TCPAddr{}, untrustedSigner.PublicKey()); err == nil {
		t.Fatal("callback() error = nil, want mismatch error")
	}
}

func TestStrictHostKeyCallbackAllowsAnyTrustedHostKey(t *testing.T) {
	firstSigner, _ := generateTestKeyPair(t)
	secondSigner, _ := generateTestKeyPair(t)
	untrustedSigner, _ := generateTestKeyPair(t)

	callback, err := hostKeyCallbackFor(
		Target{TrustedHostKeysBase64: []string{
			base64.StdEncoding.EncodeToString(firstSigner.PublicKey().Marshal()),
			base64.StdEncoding.EncodeToString(secondSigner.PublicKey().Marshal()),
		}},
		nil,
	)
	if err != nil {
		t.Fatalf("hostKeyCallbackFor() error = %v", err)
	}

	if err := callback("example.com", &net.TCPAddr{}, secondSigner.PublicKey()); err != nil {
		t.Fatalf("callback() error = %v, want nil", err)
	}
	if err := callback("example.com", &net.TCPAddr{}, untrustedSigner.PublicKey()); err == nil {
		t.Fatal("callback() error = nil, want mismatch error")
	}
}

func TestResolveAuthMethods(t *testing.T) {
	signer, privateKeyPEM := generateTestKeyPair(t)
	certificateText := generateTestCertificate(t, signer)

	passwordMethods, _, err := resolveAuthMethods(Target{
		AuthType: "password",
		Password: "secret",
	}, Config{}, nil)
	if err != nil {
		t.Fatalf("resolveAuthMethods(password) error = %v", err)
	}
	if len(passwordMethods) != 2 {
		t.Fatalf("len(passwordMethods) = %d, want 2", len(passwordMethods))
	}

	privateKeyMethods, _, err := resolveAuthMethods(Target{
		AuthType:      "privateKey",
		PrivateKeyPEM: string(privateKeyPEM),
	}, Config{}, nil)
	if err != nil {
		t.Fatalf("resolveAuthMethods(privateKey) error = %v", err)
	}
	if len(privateKeyMethods) != 3 {
		t.Fatalf("len(privateKeyMethods) = %d, want 3", len(privateKeyMethods))
	}

	certificateMethods, _, err := resolveAuthMethods(Target{
		AuthType:        "certificate",
		PrivateKeyPEM:   string(privateKeyPEM),
		CertificateText: certificateText,
	}, Config{}, nil)
	if err != nil {
		t.Fatalf("resolveAuthMethods(certificate) error = %v", err)
	}
	if len(certificateMethods) != 3 {
		t.Fatalf("len(certificateMethods) = %d, want 3", len(certificateMethods))
	}

	keyboardMethods, _, err := resolveAuthMethods(Target{
		AuthType: "keyboardInteractive",
	}, Config{}, nil)
	if err != nil {
		t.Fatalf("resolveAuthMethods(keyboardInteractive) error = %v", err)
	}
	if len(keyboardMethods) != 1 {
		t.Fatalf("len(keyboardMethods) = %d, want 1", len(keyboardMethods))
	}
}

func TestResolveAuthMethodsErrors(t *testing.T) {
	signer, privateKeyPEM := generateTestKeyPair(t)

	if _, _, err := resolveAuthMethods(Target{
		AuthType: "password",
	}, Config{}, nil); err == nil {
		t.Fatal("resolveAuthMethods(password missing secret) error = nil, want non-nil")
	}

	if _, _, err := resolveAuthMethods(Target{
		AuthType: "privateKey",
	}, Config{}, nil); err == nil {
		t.Fatal("resolveAuthMethods(privateKey missing key) error = nil, want non-nil")
	}

	if _, _, err := resolveAuthMethods(Target{
		AuthType:      "certificate",
		PrivateKeyPEM: string(privateKeyPEM),
	}, Config{}, nil); err == nil {
		t.Fatal("resolveAuthMethods(certificate missing cert) error = nil, want non-nil")
	}

	if _, _, err := resolveAuthMethods(Target{
		AuthType:        "certificate",
		PrivateKeyPEM:   string(privateKeyPEM),
		CertificateText: string(ssh.MarshalAuthorizedKey(signer.PublicKey())),
	}, Config{}, nil); err == nil {
		t.Fatal("resolveAuthMethods(certificate invalid cert) error = nil, want non-nil")
	}

	if _, _, err := resolveAuthMethods(Target{
		AuthType: "unsupported",
	}, Config{}, nil); err == nil {
		t.Fatal("resolveAuthMethods(unsupported) error = nil, want non-nil")
	}
}

func TestInspectCertificate(t *testing.T) {
	signer, _ := generateTestKeyPair(t)
	now := time.Unix(1_700_000_000, 0).UTC()

	validCertificate := generateTestCertificate(t, signer, func(cert *ssh.Certificate) {
		cert.ValidAfter = uint64(now.Add(-time.Hour).Unix())
		cert.ValidBefore = uint64(now.Add(time.Hour).Unix())
		cert.KeyId = "valid-cert"
		cert.Serial = 42
	})
	expiredCertificate := generateTestCertificate(t, signer, func(cert *ssh.Certificate) {
		cert.ValidAfter = uint64(now.Add(-2 * time.Hour).Unix())
		cert.ValidBefore = uint64(now.Add(-time.Minute).Unix())
	})
	futureCertificate := generateTestCertificate(t, signer, func(cert *ssh.Certificate) {
		cert.ValidAfter = uint64(now.Add(time.Hour).Unix())
		cert.ValidBefore = uint64(now.Add(2 * time.Hour).Unix())
	})

	valid := InspectCertificate(validCertificate, now)
	if valid.Status != "valid" {
		t.Fatalf("InspectCertificate(valid).Status = %q, want %q", valid.Status, "valid")
	}
	if valid.KeyID != "valid-cert" {
		t.Fatalf("InspectCertificate(valid).KeyID = %q, want %q", valid.KeyID, "valid-cert")
	}
	if valid.Serial != 42 {
		t.Fatalf("InspectCertificate(valid).Serial = %d, want %d", valid.Serial, 42)
	}
	if len(valid.Principals) != 1 || valid.Principals[0] != "test-user" {
		t.Fatalf("InspectCertificate(valid).Principals = %#v, want [test-user]", valid.Principals)
	}

	expired := InspectCertificate(expiredCertificate, now)
	if expired.Status != "expired" {
		t.Fatalf("InspectCertificate(expired).Status = %q, want %q", expired.Status, "expired")
	}

	notYetValid := InspectCertificate(futureCertificate, now)
	if notYetValid.Status != "not_yet_valid" {
		t.Fatalf(
			"InspectCertificate(future).Status = %q, want %q",
			notYetValid.Status,
			"not_yet_valid",
		)
	}

	invalid := InspectCertificate("ssh-ed25519 AAAAB3NzaC1yc2EAAAADAQABAAABAQ== not-a-cert", now)
	if invalid.Status != "invalid" {
		t.Fatalf("InspectCertificate(invalid).Status = %q, want %q", invalid.Status, "invalid")
	}
}

func TestInspectPrivateKey(t *testing.T) {
	signer, privateKeyPEM := generateTestKeyPair(t)

	inspected, err := InspectPrivateKey(string(privateKeyPEM), "")
	if err != nil {
		t.Fatalf("InspectPrivateKey() error = %v", err)
	}

	expectedPublicKey := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(signer.PublicKey())))
	if inspected.PublicKey != expectedPublicKey {
		t.Fatalf("InspectPrivateKey().PublicKey = %q, want %q", inspected.PublicKey, expectedPublicKey)
	}
	if inspected.Algorithm != signer.PublicKey().Type() {
		t.Fatalf("InspectPrivateKey().Algorithm = %q, want %q", inspected.Algorithm, signer.PublicKey().Type())
	}
	if inspected.FingerprintSHA256 != ssh.FingerprintSHA256(signer.PublicKey()) {
		t.Fatalf("InspectPrivateKey().FingerprintSHA256 = %q, want %q", inspected.FingerprintSHA256, ssh.FingerprintSHA256(signer.PublicKey()))
	}
}

func TestInspectPrivateKeyRejectsInvalidKey(t *testing.T) {
	if _, err := InspectPrivateKey("not a private key", ""); err == nil {
		t.Fatal("InspectPrivateKey(invalid) error = nil, want non-nil")
	}
}

func TestGeneratePrivateKeyAlgorithms(t *testing.T) {
	tests := []struct {
		name          string
		request       PrivateKeyGenerationRequest
		wantAlgorithm string
		wantCurve     string
		wantBits      int
	}{
		{
			name:          "ed25519",
			request:       PrivateKeyGenerationRequest{Algorithm: "ed25519", Comment: "test"},
			wantAlgorithm: "ssh-ed25519",
		},
		{
			name:          "ecdsa p256",
			request:       PrivateKeyGenerationRequest{Algorithm: "ecdsa", Curve: "nistp256"},
			wantAlgorithm: "ecdsa-sha2-nistp256",
			wantCurve:     "nistp256",
		},
		{
			name:          "ecdsa p384",
			request:       PrivateKeyGenerationRequest{Algorithm: "ecdsa", Curve: "nistp384"},
			wantAlgorithm: "ecdsa-sha2-nistp384",
			wantCurve:     "nistp384",
		},
		{
			name:          "ecdsa p521 default",
			request:       PrivateKeyGenerationRequest{Algorithm: "ecdsa"},
			wantAlgorithm: "ecdsa-sha2-nistp521",
			wantCurve:     "nistp521",
		},
		{
			name:          "rsa 3072",
			request:       PrivateKeyGenerationRequest{Algorithm: "rsa", RSABits: 3072},
			wantAlgorithm: "ssh-rsa",
			wantBits:      3072,
		},
		{
			name:          "rsa 4096 default",
			request:       PrivateKeyGenerationRequest{Algorithm: "rsa"},
			wantAlgorithm: "ssh-rsa",
			wantBits:      4096,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			generated, err := GeneratePrivateKey(tt.request)
			if err != nil {
				t.Fatalf("GeneratePrivateKey() error = %v", err)
			}
			if generated.Algorithm != tt.wantAlgorithm {
				t.Fatalf("GeneratePrivateKey().Algorithm = %q, want %q", generated.Algorithm, tt.wantAlgorithm)
			}
			if generated.KeyCurve != tt.wantCurve {
				t.Fatalf("GeneratePrivateKey().KeyCurve = %q, want %q", generated.KeyCurve, tt.wantCurve)
			}
			if generated.KeyBits != tt.wantBits {
				t.Fatalf("GeneratePrivateKey().KeyBits = %d, want %d", generated.KeyBits, tt.wantBits)
			}

			inspected, err := InspectPrivateKey(generated.PrivateKeyPEM, "")
			if err != nil {
				t.Fatalf("InspectPrivateKey(generated) error = %v", err)
			}
			if inspected.PublicKey != generated.PublicKey {
				t.Fatalf("InspectPrivateKey(generated).PublicKey = %q, want %q", inspected.PublicKey, generated.PublicKey)
			}
			if inspected.FingerprintSHA256 != generated.FingerprintSHA256 {
				t.Fatalf("InspectPrivateKey(generated).FingerprintSHA256 = %q, want %q", inspected.FingerprintSHA256, generated.FingerprintSHA256)
			}
		})
	}
}

func TestGeneratePrivateKeyWithPassphrase(t *testing.T) {
	generated, err := GeneratePrivateKey(PrivateKeyGenerationRequest{
		Algorithm:        "ed25519",
		PrivateKeyCipher: "aes256-cbc",
		KDFRounds:        128,
		Passphrase:       "secret",
	})
	if err != nil {
		t.Fatalf("GeneratePrivateKey() error = %v", err)
	}
	if !generated.PrivateKeyEncrypted {
		t.Fatal("GeneratePrivateKey().PrivateKeyEncrypted = false, want true")
	}
	if generated.PrivateKeyCipher != "aes256-cbc" {
		t.Fatalf("GeneratePrivateKey().PrivateKeyCipher = %q, want %q", generated.PrivateKeyCipher, "aes256-cbc")
	}
	if generated.PrivateKeyKDFRounds != 128 {
		t.Fatalf("GeneratePrivateKey().PrivateKeyKDFRounds = %d, want %d", generated.PrivateKeyKDFRounds, 128)
	}
	if !strings.Contains(generated.PrivateKeyPEM, "OPENSSH PRIVATE KEY") {
		t.Fatal("GeneratePrivateKey().PrivateKeyPEM does not look like an OpenSSH key")
	}
	if _, err := InspectPrivateKey(generated.PrivateKeyPEM, ""); err == nil {
		t.Fatal("InspectPrivateKey(encrypted, empty passphrase) error = nil, want non-nil")
	}
	if _, err := InspectPrivateKey(generated.PrivateKeyPEM, "wrong"); err == nil {
		t.Fatal("InspectPrivateKey(encrypted, wrong passphrase) error = nil, want non-nil")
	}
	inspected, err := InspectPrivateKey(generated.PrivateKeyPEM, "secret")
	if err != nil {
		t.Fatalf("InspectPrivateKey(encrypted) error = %v", err)
	}
	if inspected.PublicKey != generated.PublicKey {
		t.Fatalf("InspectPrivateKey(encrypted).PublicKey = %q, want %q", inspected.PublicKey, generated.PublicKey)
	}
}

// 서버 프록시와 tailnet 은 둘 다 대상까지의 raw 전송을 대신하므로 함께 쓸 수 없다.
//
// 지금은 호스트 종류로 갈려서(wsProxy 는 aws-ec2, tailnet 은 ssh) 동시에 설정될 일이 없다.
// 그래도 소리 나게 막는 이유는, 조용히 한쪽이 이기면 "tailnet 을 지정했는데 서버 프록시로
// 나가는" 것을 아무도 모르기 때문이다.
func TestDialClientRejectsBothWsProxyAndTailnetDialer(t *testing.T) {
	_, err := DialClient(context.Background(),
		Target{
			Host:                 "server",
			Port:                 22,
			Username:             "root",
			AuthType:             "password",
			Password:             "x",
			TrustedHostKeyBase64: "AAAA",
			WSProxy:              &coretypes.WSProxyTarget{URL: "wss://example/ws"},
		},
		Config{
			Dial: func(context.Context, string, string) (net.Conn, error) {
				t.Fatal("dialled despite the conflict")
				return nil, nil
			},
		},
		nil,
	)

	if !errors.Is(err, ErrTransportConflict) {
		t.Fatalf("DialClient() error = %v, want ErrTransportConflict", err)
	}
}

func TestProbeHostKeyRejectsBothWsProxyAndTailnetDialer(t *testing.T) {
	_, err := ProbeHostKey(context.Background(),
		"server",
		22,
		nil,
		&coretypes.WSProxyTarget{URL: "wss://example/ws"},
		Config{
			Dial: func(context.Context, string, string) (net.Conn, error) {
				t.Fatal("dialled despite the conflict")
				return nil, nil
			},
		},
	)

	if !errors.Is(err, ErrTransportConflict) {
		t.Fatalf("ProbeHostKey() error = %v, want ErrTransportConflict", err)
	}
}

// tailnet 경유 dial 은 별도 예산을 갖지 않는다.
//
// 노드를 올리는 것은 앞 단계(관문)가 끝냈고, 여기부터는 대상까지 가는 raw 연결일 뿐이라 일반 TCP
// 와 다를 이유가 없다. 따로 짧게 두었을 때 실기기에서 5 초에 걸려 붙던 호스트가 안 붙었다.
func TestDialBudgetsAreBounded(t *testing.T) {
	// 두 예산 모두 살아 있어야 한다. 어느 쪽이든 사라지면 그 경로의 dial 이 아무 한도 없이
	// 매달리고, 화면에는 이유 없이 멈춘 연결만 남는다.
	//
	// tailnet 은 일반 TCP 와 **다른** 값을 쓴다(TailnetDialTimeout) — 노드가 깨어나고 경로를
	// 찾는 시간이 그 구간에 섞이기 때문이다.
	if DefaultConfig.TCPDialTimeout <= 0 {
		t.Fatalf("TCPDialTimeout = %v, want a positive budget", DefaultConfig.TCPDialTimeout)
	}
	if DefaultConfig.TailnetDialTimeout <= 0 {
		t.Fatalf("TailnetDialTimeout = %v, want a positive budget", DefaultConfig.TailnetDialTimeout)
	}
}
