package sshconn

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"net"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
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

	callback, err := strictHostKeyCallback(base64.StdEncoding.EncodeToString(trustedSigner.PublicKey().Marshal()), nil)
	if err != nil {
		t.Fatalf("strictHostKeyCallback() error = %v", err)
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

	callback, err := strictHostKeyCallback("", []string{
		base64.StdEncoding.EncodeToString(firstSigner.PublicKey().Marshal()),
		base64.StdEncoding.EncodeToString(secondSigner.PublicKey().Marshal()),
	})
	if err != nil {
		t.Fatalf("strictHostKeyCallback() error = %v", err)
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

	passwordMethods, err := resolveAuthMethods(Target{
		AuthType: "password",
		Password: "secret",
	}, nil)
	if err != nil {
		t.Fatalf("resolveAuthMethods(password) error = %v", err)
	}
	if len(passwordMethods) != 2 {
		t.Fatalf("len(passwordMethods) = %d, want 2", len(passwordMethods))
	}

	privateKeyMethods, err := resolveAuthMethods(Target{
		AuthType:      "privateKey",
		PrivateKeyPEM: string(privateKeyPEM),
	}, nil)
	if err != nil {
		t.Fatalf("resolveAuthMethods(privateKey) error = %v", err)
	}
	if len(privateKeyMethods) != 2 {
		t.Fatalf("len(privateKeyMethods) = %d, want 2", len(privateKeyMethods))
	}

	certificateMethods, err := resolveAuthMethods(Target{
		AuthType:        "certificate",
		PrivateKeyPEM:   string(privateKeyPEM),
		CertificateText: certificateText,
	}, nil)
	if err != nil {
		t.Fatalf("resolveAuthMethods(certificate) error = %v", err)
	}
	if len(certificateMethods) != 2 {
		t.Fatalf("len(certificateMethods) = %d, want 2", len(certificateMethods))
	}

	keyboardMethods, err := resolveAuthMethods(Target{
		AuthType: "keyboardInteractive",
	}, nil)
	if err != nil {
		t.Fatalf("resolveAuthMethods(keyboardInteractive) error = %v", err)
	}
	if len(keyboardMethods) != 1 {
		t.Fatalf("len(keyboardMethods) = %d, want 1", len(keyboardMethods))
	}
}

func TestResolveAuthMethodsErrors(t *testing.T) {
	signer, privateKeyPEM := generateTestKeyPair(t)

	if _, err := resolveAuthMethods(Target{
		AuthType: "password",
	}, nil); err == nil {
		t.Fatal("resolveAuthMethods(password missing secret) error = nil, want non-nil")
	}

	if _, err := resolveAuthMethods(Target{
		AuthType: "privateKey",
	}, nil); err == nil {
		t.Fatal("resolveAuthMethods(privateKey missing key) error = nil, want non-nil")
	}

	if _, err := resolveAuthMethods(Target{
		AuthType:      "certificate",
		PrivateKeyPEM: string(privateKeyPEM),
	}, nil); err == nil {
		t.Fatal("resolveAuthMethods(certificate missing cert) error = nil, want non-nil")
	}

	if _, err := resolveAuthMethods(Target{
		AuthType:        "certificate",
		PrivateKeyPEM:   string(privateKeyPEM),
		CertificateText: string(ssh.MarshalAuthorizedKey(signer.PublicKey())),
	}, nil); err == nil {
		t.Fatal("resolveAuthMethods(certificate invalid cert) error = nil, want non-nil")
	}

	if _, err := resolveAuthMethods(Target{
		AuthType: "unsupported",
	}, nil); err == nil {
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
