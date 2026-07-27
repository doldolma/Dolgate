package session

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"dolssh/services/ssh-core/internal/sshconn"
)

// The fixture's SFTP server serves the host filesystem, so these tests operate
// inside a temp directory and assert against real protocol responses.
func newSFTP(t *testing.T) (*SFTP, string) {
	t.Helper()

	server := newTestServer(t)
	conn, err := Dial(DialOptions{ID: "conn-1", Target: server.Target(), Config: sshconn.DefaultConfig})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })

	sftp, err := conn.StartSFTP()
	if err != nil {
		t.Fatalf("start sftp: %v", err)
	}
	t.Cleanup(func() { _ = sftp.Close() })

	return sftp, t.TempDir()
}

func TestSFTPListReportsEntries(t *testing.T) {
	sftp, dir := newSFTP(t)

	if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatalf("seed file: %v", err)
	}
	if err := os.Mkdir(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatalf("seed dir: %v", err)
	}

	listing, err := sftp.List(dir)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if listing.Path != dir {
		t.Errorf("listing path = %q, want %q", listing.Path, dir)
	}
	if len(listing.Entries) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(listing.Entries))
	}

	byName := map[string]int{}
	for i, entry := range listing.Entries {
		byName[entry.Name] = i
	}

	file := listing.Entries[byName["note.txt"]]
	if file.IsDirectory || file.Kind != "file" {
		t.Errorf("note.txt = kind %q isDir %v, want file/false", file.Kind, file.IsDirectory)
	}
	if file.Size != int64(len("hello")) {
		t.Errorf("note.txt size = %d, want %d", file.Size, len("hello"))
	}
	if file.Path != filepath.Join(dir, "note.txt") {
		t.Errorf("note.txt path = %q", file.Path)
	}
	// The browser sorts and formats on these, so they must be populated the same
	// way the desktop populates them.
	if file.Mtime == "" {
		t.Error("note.txt has no mtime")
	}
	if file.Permissions == "" {
		t.Error("note.txt has no permissions string")
	}

	sub := listing.Entries[byName["sub"]]
	if !sub.IsDirectory || sub.Kind != "folder" {
		t.Errorf("sub = kind %q isDir %v, want folder/true", sub.Kind, sub.IsDirectory)
	}
}

func TestSFTPListReportsSymlinkKind(t *testing.T) {
	sftp, dir := newSFTP(t)

	if err := os.WriteFile(filepath.Join(dir, "target.txt"), []byte("x"), 0o644); err != nil {
		t.Fatalf("seed file: %v", err)
	}
	if err := os.Symlink(filepath.Join(dir, "target.txt"), filepath.Join(dir, "link.txt")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	listing, err := sftp.List(dir)
	if err != nil {
		t.Fatalf("list: %v", err)
	}

	for _, entry := range listing.Entries {
		if entry.Name == "link.txt" {
			if entry.Kind != "symlink" {
				t.Errorf("link.txt kind = %q, want symlink", entry.Kind)
			}
			return
		}
	}
	t.Error("the symlink was not listed")
}

func TestSFTPListRejectsMissingDirectory(t *testing.T) {
	sftp, dir := newSFTP(t)

	if _, err := sftp.List(filepath.Join(dir, "nope")); err == nil {
		t.Error("expected an error listing a missing directory")
	}
}

// A chunked download must reassemble byte-exactly and report the end of the
// file, which is how the transfer loop knows to stop.
func TestSFTPReadChunkWalksAFileToEOF(t *testing.T) {
	sftp, dir := newSFTP(t)

	content := bytes.Repeat([]byte("abcdefghij"), 50) // 500 bytes
	remote := filepath.Join(dir, "payload.bin")
	if err := os.WriteFile(remote, content, 0o644); err != nil {
		t.Fatalf("seed file: %v", err)
	}

	const chunk = 128
	var got []byte
	offset := int64(0)
	for {
		data, eof, err := sftp.ReadChunk(remote, offset, chunk)
		if err != nil {
			t.Fatalf("read at %d: %v", offset, err)
		}
		got = append(got, data...)
		offset += int64(len(data))
		if eof {
			break
		}
		if offset > int64(len(content)) {
			t.Fatal("read past the end without reporting eof")
		}
	}

	if !bytes.Equal(got, content) {
		t.Errorf("reassembled %d bytes, want %d", len(got), len(content))
	}
}

func TestSFTPReadChunkAtOffset(t *testing.T) {
	sftp, dir := newSFTP(t)

	remote := filepath.Join(dir, "offset.txt")
	if err := os.WriteFile(remote, []byte("0123456789"), 0o644); err != nil {
		t.Fatalf("seed file: %v", err)
	}

	data, eof, err := sftp.ReadChunk(remote, 4, 3)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(data) != "456" {
		t.Errorf("read %q, want %q", data, "456")
	}
	// A full read that stopped short of the end is not eof.
	if eof {
		t.Error("eof reported mid-file")
	}
}

func TestSFTPReadChunkRejectsBadInput(t *testing.T) {
	sftp, dir := newSFTP(t)

	if _, _, err := sftp.ReadChunk(filepath.Join(dir, "missing"), 0, 16); err == nil {
		t.Error("expected an error reading a missing file")
	}
	remote := filepath.Join(dir, "x.txt")
	if err := os.WriteFile(remote, []byte("x"), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, _, err := sftp.ReadChunk(remote, 0, 0); err == nil {
		t.Error("expected an error for a non-positive read length")
	}
}

// A chunked upload must land as one contiguous file: each chunk seeks rather
// than truncating, which is the bug a naive implementation has.
func TestSFTPWriteChunkAssemblesAnUpload(t *testing.T) {
	sftp, dir := newSFTP(t)

	remote := filepath.Join(dir, "upload.bin")
	content := bytes.Repeat([]byte("XYZ"), 100) // 300 bytes

	const chunk = 64
	for offset := 0; offset < len(content); offset += chunk {
		end := offset + chunk
		if end > len(content) {
			end = len(content)
		}
		if err := sftp.WriteChunk(remote, int64(offset), content[offset:end]); err != nil {
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

func TestSFTPMkdirRenameRemove(t *testing.T) {
	sftp, dir := newSFTP(t)

	created := filepath.Join(dir, "created")
	if err := sftp.Mkdir(created); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if info, err := os.Stat(created); err != nil || !info.IsDir() {
		t.Fatalf("directory was not created: %v", err)
	}

	renamed := filepath.Join(dir, "renamed")
	if err := sftp.Rename(created, renamed); err != nil {
		t.Fatalf("rename: %v", err)
	}
	if _, err := os.Stat(created); !os.IsNotExist(err) {
		t.Error("the old path still exists after rename")
	}

	// Remove has to handle a directory as well as a file.
	if err := sftp.Remove(renamed); err != nil {
		t.Fatalf("remove directory: %v", err)
	}
	if _, err := os.Stat(renamed); !os.IsNotExist(err) {
		t.Error("the directory still exists after remove")
	}

	file := filepath.Join(dir, "file.txt")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := sftp.Remove(file); err != nil {
		t.Fatalf("remove file: %v", err)
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Error("the file still exists after remove")
	}
}

func TestSFTPChmod(t *testing.T) {
	sftp, dir := newSFTP(t)

	remote := filepath.Join(dir, "perm.txt")
	if err := os.WriteFile(remote, []byte("x"), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}

	if err := sftp.Chmod(remote, 0o600); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	info, err := os.Stat(remote)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("mode = %o, want 600", info.Mode().Perm())
	}
}

func TestSFTPStat(t *testing.T) {
	sftp, dir := newSFTP(t)

	remote := filepath.Join(dir, "stat.txt")
	if err := os.WriteFile(remote, []byte("hello"), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}

	entry, err := sftp.Stat(remote)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if entry.Name != "stat.txt" || entry.Size != 5 || entry.Kind != "file" {
		t.Errorf("entry = %+v", entry)
	}

	if _, err := sftp.Stat(filepath.Join(dir, "missing")); err == nil {
		t.Error("expected an error stat-ing a missing path")
	}
}

func TestSFTPCloseIsIdempotentAndBlocksFurtherUse(t *testing.T) {
	sftp, dir := newSFTP(t)

	if err := sftp.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if err := sftp.Close(); err != nil {
		t.Fatalf("second close: %v", err)
	}

	if _, err := sftp.List(dir); err != ErrSFTPClosed {
		t.Errorf("List after close returned %v, want ErrSFTPClosed", err)
	}
	if err := sftp.Mkdir(filepath.Join(dir, "x")); err != ErrSFTPClosed {
		t.Errorf("Mkdir after close returned %v, want ErrSFTPClosed", err)
	}
}

func TestStartSFTPFailsOnClosedConnection(t *testing.T) {
	server := newTestServer(t)
	conn, err := Dial(DialOptions{ID: "conn-1", Target: server.Target(), Config: sshconn.DefaultConfig})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	if err := conn.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	if _, err := conn.StartSFTP(); err == nil {
		t.Error("expected StartSFTP to fail on a closed connection")
	}
}

// A shell and an SFTP session share one transport, so opening both must work.
func TestSFTPCoexistsWithAShell(t *testing.T) {
	server := newTestServer(t)
	conn, err := Dial(DialOptions{ID: "conn-1", Target: server.Target(), Config: sshconn.DefaultConfig})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	shell, err := conn.StartShell(ShellOptions{Term: TerminalXterm256})
	if err != nil {
		t.Fatalf("start shell: %v", err)
	}
	defer shell.Close()

	sftp, err := conn.StartSFTP()
	if err != nil {
		t.Fatalf("start sftp: %v", err)
	}
	defer sftp.Close()

	dir := t.TempDir()
	if _, err := sftp.List(dir); err != nil {
		t.Fatalf("list while a shell is open: %v", err)
	}
	if err := shell.SendData([]byte("still-alive\n")); err != nil {
		t.Fatalf("shell write while sftp is open: %v", err)
	}
	waitForRing(t, shell, "still-alive\n")
}
