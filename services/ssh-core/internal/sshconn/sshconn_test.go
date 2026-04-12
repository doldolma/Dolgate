package sshconn

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"net"
	"os"
	"path/filepath"
	"testing"

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

func generateTestCertificate(t *testing.T, userSigner ssh.Signer) string {
	t.Helper()

	caSigner, _ := generateTestKeyPair(t)
	cert := &ssh.Certificate{
		Key:             userSigner.PublicKey(),
		Serial:          1,
		CertType:        ssh.UserCert,
		ValidPrincipals: []string{"test-user"},
		ValidBefore:     ssh.CertTimeInfinity,
	}
	if err := cert.SignCert(rand.Reader, caSigner); err != nil {
		t.Fatalf("cert.SignCert() error = %v", err)
	}
	return string(ssh.MarshalAuthorizedKey(cert))
}

func TestStrictHostKeyCallback(t *testing.T) {
	trustedSigner, _ := generateTestKeyPair(t)
	untrustedSigner, _ := generateTestKeyPair(t)

	callback, err := strictHostKeyCallback(base64.StdEncoding.EncodeToString(trustedSigner.PublicKey().Marshal()))
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

func TestResolveAuthMethodsPrivateKeyPathAndErrors(t *testing.T) {
	signer, privateKeyPEM := generateTestKeyPair(t)
	keyPath := filepath.Join(t.TempDir(), "id_rsa")
	if err := os.WriteFile(keyPath, privateKeyPEM, 0o600); err != nil {
		t.Fatalf("os.WriteFile() error = %v", err)
	}
	certificateText := generateTestCertificate(t, signer)
	certificatePath := filepath.Join(t.TempDir(), "id_rsa-cert.pub")
	if err := os.WriteFile(certificatePath, []byte(certificateText), 0o600); err != nil {
		t.Fatalf("os.WriteFile(certificatePath) error = %v", err)
	}

	if _, err := resolveAuthMethods(Target{
		AuthType:       "privateKey",
		PrivateKeyPath: keyPath,
	}, nil); err != nil {
		t.Fatalf("resolveAuthMethods(privateKey path) error = %v", err)
	}

	if _, err := resolveAuthMethods(Target{
		AuthType:        "certificate",
		PrivateKeyPath:  keyPath,
		CertificatePath: certificatePath,
	}, nil); err != nil {
		t.Fatalf("resolveAuthMethods(certificate path) error = %v", err)
	}

	if _, err := resolveAuthMethods(Target{
		AuthType: "password",
	}, nil); err == nil {
		t.Fatal("resolveAuthMethods(password missing secret) error = nil, want non-nil")
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
