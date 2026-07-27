package mobile

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func newBoundSFTP(t *testing.T) (*SFTPSession, string) {
	t.Helper()

	server := newTestServer(t)
	conn := connectTest(t, server, 30, 100)
	sftp, err := conn.StartSFTP()
	if err != nil {
		t.Fatalf("start sftp: %v", err)
	}
	t.Cleanup(func() { _ = sftp.Close() })
	return sftp, t.TempDir()
}

type boundListing struct {
	Path    string `json:"path"`
	Entries []struct {
		Name        string `json:"name"`
		Path        string `json:"path"`
		IsDirectory bool   `json:"isDirectory"`
		Size        int64  `json:"size"`
		Mtime       string `json:"mtime"`
		Kind        string `json:"kind"`
		Permissions string `json:"permissions"`
	} `json:"entries"`
}

// The file browser consumes these records directly, so the JSON keys are the
// contract — same ones the desktop engine sends.
func TestBoundListJSONShape(t *testing.T) {
	sftp, dir := newBoundSFTP(t)

	if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}

	raw, err := sftp.ListJSON(dir)
	if err != nil {
		t.Fatalf("list: %v", err)
	}

	var listing boundListing
	if err := json.Unmarshal([]byte(raw), &listing); err != nil {
		t.Fatalf("decode listing: %v", err)
	}
	if listing.Path != dir {
		t.Errorf("path = %q, want %q", listing.Path, dir)
	}
	if len(listing.Entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(listing.Entries))
	}

	entry := listing.Entries[0]
	if entry.Name != "note.txt" || entry.Kind != "file" || entry.Size != 5 {
		t.Errorf("entry = %+v", entry)
	}
	if entry.Mtime == "" || entry.Permissions == "" {
		t.Errorf("entry is missing display fields: %+v", entry)
	}
}

func TestBoundReadChunkReportsEOF(t *testing.T) {
	sftp, dir := newBoundSFTP(t)

	remote := filepath.Join(dir, "payload.bin")
	content := bytes.Repeat([]byte("ab"), 100) // 200 bytes
	if err := os.WriteFile(remote, content, 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}

	first, err := sftp.ReadChunk(remote, 0, 128)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(first.Data()) != 128 {
		t.Errorf("first read returned %d bytes, want 128", len(first.Data()))
	}
	if first.EOF() {
		t.Error("eof reported mid-file")
	}

	second, err := sftp.ReadChunk(remote, 128, 128)
	if err != nil {
		t.Fatalf("read tail: %v", err)
	}
	if len(second.Data()) != 72 {
		t.Errorf("tail read returned %d bytes, want 72", len(second.Data()))
	}
	if !second.EOF() {
		t.Error("eof was not reported at the end of the file")
	}

	if !bytes.Equal(append(first.Data(), second.Data()...), content) {
		t.Error("the two reads did not reassemble the file")
	}
}

func TestBoundWriteChunkAssemblesUpload(t *testing.T) {
	sftp, dir := newBoundSFTP(t)

	remote := filepath.Join(dir, "upload.bin")
	content := bytes.Repeat([]byte("Z"), 300)

	for offset := 0; offset < len(content); offset += 100 {
		if err := sftp.WriteChunk(remote, int64(offset), content[offset:offset+100]); err != nil {
			t.Fatalf("write at %d: %v", offset, err)
		}
	}

	written, err := os.ReadFile(remote)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if !bytes.Equal(written, content) {
		t.Errorf("uploaded %d bytes, want %d", len(written), len(content))
	}
}

func TestBoundSFTPMutations(t *testing.T) {
	sftp, dir := newBoundSFTP(t)

	created := filepath.Join(dir, "dir")
	if err := sftp.Mkdir(created); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	renamed := filepath.Join(dir, "dir2")
	if err := sftp.Rename(created, renamed); err != nil {
		t.Fatalf("rename: %v", err)
	}
	if err := sftp.Remove(renamed); err != nil {
		t.Fatalf("remove: %v", err)
	}

	file := filepath.Join(dir, "f.txt")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := sftp.Chmod(file, 0o600); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	info, err := os.Stat(file)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("mode = %o, want 600", info.Mode().Perm())
	}

	raw, err := sftp.StatJSON(file)
	if err != nil {
		t.Fatalf("statJSON: %v", err)
	}
	var entry struct {
		Name string `json:"name"`
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal([]byte(raw), &entry); err != nil {
		t.Fatalf("decode stat: %v", err)
	}
	if entry.Name != "f.txt" || entry.Kind != "file" {
		t.Errorf("stat entry = %+v", entry)
	}
}

func TestBoundChmodRejectsOutOfRangeMode(t *testing.T) {
	sftp, dir := newBoundSFTP(t)

	file := filepath.Join(dir, "f.txt")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := sftp.Chmod(file, -1); err == nil {
		t.Error("expected an error for negative permission bits")
	}
}

// The vault is end-to-end encrypted, so the bound derivation has to produce the
// same KEK as every other implementation. The shared vectors are the authority;
// mobile/vaultkdf checks all of them, and this confirms the bound entry point
// carries the parameters through unchanged.
func TestBoundDeriveArgon2idMatchesSharedVector(t *testing.T) {
	engine := NewEngine()

	salt, err := base64.StdEncoding.DecodeString("srKysrKysrKysrKysrKysg==")
	if err != nil {
		t.Fatalf("decode salt: %v", err)
	}
	const wantKEK = "ckDiwZJZCC9qdDxXY3KwV45D/Sq7/4HG/MX+S0vf0vA="

	got, err := engine.DeriveArgon2idKey(
		[]byte("correct horse battery staple"),
		salt,
		8192, 3, 1, 32,
	)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	if base64.StdEncoding.EncodeToString(got) != wantKEK {
		t.Errorf("KEK = %s, want %s", base64.StdEncoding.EncodeToString(got), wantKEK)
	}
}

func TestBoundDeriveArgon2idRejectsBadInput(t *testing.T) {
	engine := NewEngine()
	salt := []byte("0123456789abcdef")

	if _, err := engine.DeriveArgon2idKey(nil, salt, 8192, 3, 1, 32); err == nil {
		t.Error("expected an error for an empty passphrase")
	}
	if _, err := engine.DeriveArgon2idKey([]byte("p"), []byte("short"), 8192, 3, 1, 32); err == nil {
		t.Error("expected an error for a short salt")
	}
	if _, err := engine.DeriveArgon2idKey([]byte("p"), salt, 1, 3, 1, 32); err == nil {
		t.Error("expected an error for out-of-range memory")
	}
}

func TestBoundSFTPCloseBlocksFurtherUse(t *testing.T) {
	sftp, dir := newBoundSFTP(t)

	if err := sftp.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if _, err := sftp.ListJSON(dir); err == nil {
		t.Error("expected an error listing after close")
	}
}
