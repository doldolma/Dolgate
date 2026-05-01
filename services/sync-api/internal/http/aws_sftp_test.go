package http

import (
	"encoding/base64"
	"testing"
)

func TestValidateTrustedAwsSftpHostKeyAllowsAnyTrustedKey(t *testing.T) {
	actual := base64.StdEncoding.EncodeToString([]byte("actual-key"))
	other := base64.StdEncoding.EncodeToString([]byte("other-key"))

	err := validateTrustedAwsSftpHostKey(
		awsSftpHostKeyInfo{KeyBase64: actual},
		"",
		[]string{other, actual},
	)
	if err != nil {
		t.Fatalf("validateTrustedAwsSftpHostKey() error = %v", err)
	}
}

func TestValidateTrustedAwsSftpHostKeyKeepsSingularCompatibility(t *testing.T) {
	actual := base64.StdEncoding.EncodeToString([]byte("actual-key"))

	err := validateTrustedAwsSftpHostKey(
		awsSftpHostKeyInfo{KeyBase64: actual},
		actual,
		nil,
	)
	if err != nil {
		t.Fatalf("validateTrustedAwsSftpHostKey() error = %v", err)
	}
}

func TestValidateTrustedAwsSftpHostKeyRejectsMissingMatch(t *testing.T) {
	actual := base64.StdEncoding.EncodeToString([]byte("actual-key"))
	other := base64.StdEncoding.EncodeToString([]byte("other-key"))

	err := validateTrustedAwsSftpHostKey(
		awsSftpHostKeyInfo{KeyBase64: actual},
		"",
		[]string{other},
	)
	if err == nil {
		t.Fatal("validateTrustedAwsSftpHostKey() error = nil, want host key challenge")
	}
}
