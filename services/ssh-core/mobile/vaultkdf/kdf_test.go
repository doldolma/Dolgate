package vaultkdf

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"unicode/utf8"
)

// sharedVectorsPath points at the vectors shared with the TypeScript and Rust
// implementations. Reading them from their canonical location, rather than
// copying values into this test, is what keeps the three in step.
const sharedVectorsPath = "../../../../packages/shared-core/src/vault-test-vectors.json"

type kdfVector struct {
	Passphrase  string `json:"passphrase"`
	SaltBase64  string `json:"saltBase64"`
	MemoryKiB   int    `json:"memoryKib"`
	TimeCost    int    `json:"timeCost"`
	Parallelism int    `json:"parallelism"`
	KEKBase64   string `json:"kekBase64"`
}

type sharedVectors struct {
	KDF []kdfVector `json:"kdf"`
}

func loadVectors(t *testing.T) sharedVectors {
	t.Helper()

	raw, err := os.ReadFile(filepath.Clean(sharedVectorsPath))
	if err != nil {
		t.Fatalf("read shared vectors: %v", err)
	}
	var vectors sharedVectors
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatalf("parse shared vectors: %v", err)
	}
	if len(vectors.KDF) == 0 {
		t.Fatal("shared vectors contain no kdf cases")
	}
	return vectors
}

// The vault is end-to-end encrypted, so a KEK that differs from what the other
// implementations produce would leave an existing vault undecryptable. This is
// the hard gate on that.
func TestDeriveMatchesSharedVectors(t *testing.T) {
	vectors := loadVectors(t)

	for i, vector := range vectors.KDF {
		salt, err := base64.StdEncoding.DecodeString(vector.SaltBase64)
		if err != nil {
			t.Fatalf("vector %d: decode salt: %v", i, err)
		}
		want, err := base64.StdEncoding.DecodeString(vector.KEKBase64)
		if err != nil {
			t.Fatalf("vector %d: decode expected kek: %v", i, err)
		}

		got, err := Derive(
			[]byte(vector.Passphrase),
			salt,
			vector.MemoryKiB,
			vector.TimeCost,
			vector.Parallelism,
			len(want),
		)
		if err != nil {
			t.Fatalf("vector %d: derive: %v", i, err)
		}

		if base64.StdEncoding.EncodeToString(got) != vector.KEKBase64 {
			t.Errorf(
				"vector %d (memoryKib=%d timeCost=%d parallelism=%d) produced a different KEK\n got  %s\n want %s",
				i, vector.MemoryKiB, vector.TimeCost, vector.Parallelism,
				base64.StdEncoding.EncodeToString(got), vector.KEKBase64,
			)
		}
	}
}

// At least one vector must carry a non-ASCII passphrase: the bytes handed to
// Argon2id depend on the caller's text encoding, and a regression there would
// only ever show up for users whose passphrase is not plain ASCII.
func TestSharedVectorsCoverNonAsciiPassphrase(t *testing.T) {
	vectors := loadVectors(t)

	for _, vector := range vectors.KDF {
		if utf8.RuneCountInString(vector.Passphrase) != len(vector.Passphrase) {
			return
		}
	}
	t.Error("no shared vector uses a multi-byte passphrase")
}

func TestDeriveIsDeterministic(t *testing.T) {
	salt := []byte("0123456789abcdef")

	first, err := Derive([]byte("passphrase"), salt, MinMemoryKiB, 2, 1, 32)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	second, err := Derive([]byte("passphrase"), salt, MinMemoryKiB, 2, 1, 32)
	if err != nil {
		t.Fatalf("derive again: %v", err)
	}

	if base64.StdEncoding.EncodeToString(first) != base64.StdEncoding.EncodeToString(second) {
		t.Error("two derivations with the same inputs differed")
	}
}

func TestDeriveIsSensitiveToEveryInput(t *testing.T) {
	salt := []byte("0123456789abcdef")
	base, err := Derive([]byte("passphrase"), salt, MinMemoryKiB, 2, 1, 32)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	baseText := base64.StdEncoding.EncodeToString(base)

	cases := map[string]func() ([]byte, error){
		"passphrase": func() ([]byte, error) {
			return Derive([]byte("passphrasf"), salt, MinMemoryKiB, 2, 1, 32)
		},
		"salt": func() ([]byte, error) {
			return Derive([]byte("passphrase"), []byte("fedcba9876543210"), MinMemoryKiB, 2, 1, 32)
		},
		"memory": func() ([]byte, error) {
			return Derive([]byte("passphrase"), salt, MinMemoryKiB*2, 2, 1, 32)
		},
		"timeCost": func() ([]byte, error) {
			return Derive([]byte("passphrase"), salt, MinMemoryKiB, 3, 1, 32)
		},
		"parallelism": func() ([]byte, error) {
			return Derive([]byte("passphrase"), salt, MinMemoryKiB, 2, 2, 32)
		},
	}

	for name, derive := range cases {
		got, err := derive()
		if err != nil {
			t.Fatalf("%s: derive: %v", name, err)
		}
		if base64.StdEncoding.EncodeToString(got) == baseText {
			t.Errorf("changing %s did not change the derived key", name)
		}
	}
}

func TestDeriveRejectsOutOfRangeInputs(t *testing.T) {
	salt := []byte("0123456789abcdef")

	cases := map[string]func() ([]byte, error){
		"empty passphrase": func() ([]byte, error) {
			return Derive(nil, salt, MinMemoryKiB, 2, 1, 32)
		},
		"short salt": func() ([]byte, error) {
			return Derive([]byte("p"), []byte("short"), MinMemoryKiB, 2, 1, 32)
		},
		"low memory": func() ([]byte, error) {
			return Derive([]byte("p"), salt, MinMemoryKiB-1, 2, 1, 32)
		},
		"high memory": func() ([]byte, error) {
			return Derive([]byte("p"), salt, MaxMemoryKiB+1, 2, 1, 32)
		},
		"zero time cost": func() ([]byte, error) {
			return Derive([]byte("p"), salt, MinMemoryKiB, 0, 1, 32)
		},
		"zero parallelism": func() ([]byte, error) {
			return Derive([]byte("p"), salt, MinMemoryKiB, 2, 0, 32)
		},
		"short output": func() ([]byte, error) {
			return Derive([]byte("p"), salt, MinMemoryKiB, 2, 1, MinOutputLength-1)
		},
		"long output": func() ([]byte, error) {
			return Derive([]byte("p"), salt, MinMemoryKiB, 2, 1, MaxOutputLength+1)
		},
	}

	for name, derive := range cases {
		if _, err := derive(); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}
