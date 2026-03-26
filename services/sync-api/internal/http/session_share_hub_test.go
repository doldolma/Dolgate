package http

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestValidateViewerInputMessage(t *testing.T) {
	t.Run("accepts binary payloads with valid base64", func(t *testing.T) {
		message := viewerInputMessage{
			Type:     "input",
			Encoding: "binary",
			Data:     base64.StdEncoding.EncodeToString([]byte{0x1b, 0x5b, 0x41}),
		}

		if !validateViewerInputMessage(message) {
			t.Fatal("expected binary viewer input to be accepted")
		}
	})

	t.Run("rejects invalid base64 payloads", func(t *testing.T) {
		message := viewerInputMessage{
			Type:     "input",
			Encoding: "binary",
			Data:     "not-base64!!!",
		}

		if validateViewerInputMessage(message) {
			t.Fatal("expected invalid binary viewer input to be rejected")
		}
	})

	t.Run("accepts utf8 payloads", func(t *testing.T) {
		message := viewerInputMessage{
			Type:     "input",
			Encoding: "utf8",
			Data:     "한글",
		}

		if !validateViewerInputMessage(message) {
			t.Fatal("expected utf8 viewer input to be accepted")
		}
	})

	t.Run("rejects oversized payloads", func(t *testing.T) {
		message := viewerInputMessage{
			Type:     "input",
			Encoding: "utf8",
			Data:     strings.Repeat("a", maxViewerInputBytes+1),
		}

		if validateViewerInputMessage(message) {
			t.Fatal("expected oversized viewer input to be rejected")
		}
	})
}

func TestValidateViewerControlSignalMessage(t *testing.T) {
	t.Run("accepts supported control signals", func(t *testing.T) {
		message := viewerControlSignalMessage{
			Type:   "control-signal",
			Signal: "interrupt",
		}

		if !validateViewerControlSignalMessage(message) {
			t.Fatal("expected control signal to be accepted")
		}
	})

	t.Run("rejects unsupported control signals", func(t *testing.T) {
		message := viewerControlSignalMessage{
			Type:   "control-signal",
			Signal: "break",
		}

		if validateViewerControlSignalMessage(message) {
			t.Fatal("expected unsupported control signal to be rejected")
		}
	})
}

func TestSessionShareTransportValidation(t *testing.T) {
	if !isValidSessionShareTransport("") {
		t.Fatal("empty transport should default to ssh")
	}
	if !isValidSessionShareTransport("ssh") {
		t.Fatal("ssh transport should be valid")
	}
	if !isValidSessionShareTransport("aws-ssm") {
		t.Fatal("aws-ssm transport should be valid")
	}
	if normalizeSessionShareTransport("aws-ssm") != "aws-ssm" {
		t.Fatal("aws-ssm transport should be preserved")
	}
	if normalizeSessionShareTransport("invalid") != "ssh" {
		t.Fatal("unknown transport should fall back to ssh")
	}
}
