// Package vaultkdf derives the sync vault's key-encryption key.
//
// The vault is end-to-end encrypted, so this derivation is a compatibility
// contract rather than an implementation detail: a KEK that differs by one byte
// from what another platform produces makes an existing vault undecryptable.
// The shared vectors in packages/shared-core/src/vault-test-vectors.json pin it
// down, and kdf_test.go checks this implementation against them — the same
// vectors the Rust implementation was checked against.
//
// Passphrase normalisation (NFC) stays on the caller's side, because it belongs
// with the text handling rather than the KDF; this package takes bytes.
package vaultkdf

import (
	"errors"
	"fmt"

	"golang.org/x/crypto/argon2"
)

// Cost parameters accepted by Derive. These mirror the limits in
// shared-core's vault.ts; anything outside them is a caller bug rather than a
// user-facing condition, so it is rejected instead of clamped.
const (
	MinMemoryKiB    = 8 * 1024
	MaxMemoryKiB    = 1024 * 1024
	MinTimeCost     = 1
	MaxTimeCost     = 16
	MinParallelism  = 1
	MaxParallelism  = 16
	MinOutputLength = 16
	MaxOutputLength = 64
	MinSaltLength   = 8
	MaxSaltLength   = 64
)

// ErrEmptyPassphrase is returned when there is nothing to derive from.
var ErrEmptyPassphrase = errors.New("passphrase is empty")

// Derive returns the Argon2id key for the given passphrase and salt.
//
// memoryKiB is the memory cost in kibibytes, timeCost the number of passes, and
// parallelism the number of lanes; all three are part of the stored vault
// metadata and must be passed through unchanged when unwrapping an existing
// vault.
func Derive(
	passphrase []byte,
	salt []byte,
	memoryKiB int,
	timeCost int,
	parallelism int,
	outputLength int,
) ([]byte, error) {
	if len(passphrase) == 0 {
		return nil, ErrEmptyPassphrase
	}
	if len(salt) < MinSaltLength || len(salt) > MaxSaltLength {
		return nil, fmt.Errorf("salt must be %d-%d bytes, got %d", MinSaltLength, MaxSaltLength, len(salt))
	}
	if memoryKiB < MinMemoryKiB || memoryKiB > MaxMemoryKiB {
		return nil, fmt.Errorf("memoryKib must be %d-%d, got %d", MinMemoryKiB, MaxMemoryKiB, memoryKiB)
	}
	if timeCost < MinTimeCost || timeCost > MaxTimeCost {
		return nil, fmt.Errorf("timeCost must be %d-%d, got %d", MinTimeCost, MaxTimeCost, timeCost)
	}
	if parallelism < MinParallelism || parallelism > MaxParallelism {
		return nil, fmt.Errorf("parallelism must be %d-%d, got %d", MinParallelism, MaxParallelism, parallelism)
	}
	if outputLength < MinOutputLength || outputLength > MaxOutputLength {
		return nil, fmt.Errorf("outputLength must be %d-%d, got %d", MinOutputLength, MaxOutputLength, outputLength)
	}

	return argon2.IDKey(
		passphrase,
		salt,
		uint32(timeCost),
		uint32(memoryKiB),
		uint8(parallelism),
		uint32(outputLength),
	), nil
}
