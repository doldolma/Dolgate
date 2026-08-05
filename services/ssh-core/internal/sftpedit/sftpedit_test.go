package sftpedit

import (
	"os"
	"testing"
	"time"
)

func TestLooksBinary(t *testing.T) {
	if LooksBinary([]byte("plain text\nwith lines\n")) {
		t.Fatal("text content should not be flagged as binary")
	}
	if !LooksBinary([]byte{'a', 'b', 0x00, 'c'}) {
		t.Fatal("content with a NUL byte should be flagged as binary")
	}
	if LooksBinary(nil) {
		t.Fatal("empty content should not be flagged as binary")
	}
}

// NUL 판정은 앞 8KB 만 본다 — 그 뒤에 있는 NUL 은 못 잡는다는 걸 명시해 둔다.
func TestLooksBinaryOnlySniffsTheHead(t *testing.T) {
	content := append(make([]byte, binarySniffBytes), 0x00)
	for i := range content[:binarySniffBytes] {
		content[i] = 'a'
	}
	if LooksBinary(content) {
		t.Fatal("a NUL past the sniff window should not be flagged")
	}
}

type fakeInfo struct {
	os.FileInfo
	size    int64
	modTime time.Time
	mode    os.FileMode
}

func (f fakeInfo) Size() int64        { return f.size }
func (f fakeInfo) ModTime() time.Time { return f.modTime }
func (f fakeInfo) Mode() os.FileMode  { return f.mode }

func TestCheckConflictDetectsSizeAndMtimeChanges(t *testing.T) {
	opened := time.Date(2026, 8, 4, 1, 2, 3, 0, time.UTC)
	info := fakeInfo{size: 100, modTime: opened}
	size := int64(100)
	other := int64(101)

	if err := CheckConflict(info, nil, ConflictCheck{
		ExpectedSize:  &size,
		ExpectedMtime: FormatMtime(opened),
	}); err != nil {
		t.Fatalf("unchanged file reported a conflict: %v", err)
	}

	if err := CheckConflict(info, nil, ConflictCheck{ExpectedSize: &other}); err == nil {
		t.Fatal("a changed size should report a conflict")
	}
	if err := CheckConflict(info, nil, ConflictCheck{
		ExpectedMtime: FormatMtime(opened.Add(time.Second)),
	}); err == nil {
		t.Fatal("a changed mtime should report a conflict")
	}

	// Force 는 사용자가 "덮어쓰기"를 고른 경우다 — 그때는 검사하지 않는다.
	if err := CheckConflict(info, nil, ConflictCheck{
		ExpectedSize: &other,
		Force:        true,
	}); err != nil {
		t.Fatalf("force should skip the conflict check: %v", err)
	}
}

func TestResolveModeKeepsExistingPermissions(t *testing.T) {
	info := fakeInfo{mode: 0o600}
	if got := ResolveMode(0, info, nil); got != 0o600 {
		t.Fatalf("ResolveMode(0) = %o, want the file's own 600", got)
	}
	if got := ResolveMode(0o755, info, nil); got != 0o755 {
		t.Fatalf("ResolveMode(755) = %o, want 755", got)
	}
	// 새 파일(stat 실패)은 안전한 기본값으로 떨어진다.
	if got := ResolveMode(0, nil, os.ErrNotExist); got != 0o644 {
		t.Fatalf("ResolveMode for a new file = %o, want 644", got)
	}
}
