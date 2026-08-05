// Package sftpedit holds the rules the built-in remote file editor runs on:
// what may be opened as text, how a save is written, and how a save notices the
// remote changed underneath it.
//
// Both SFTP entry points call in here — the desktop protocol service
// (internal/sftp) and the gomobile bind (mobile/session). Keeping one copy is
// the point: these rules decide whether a save can truncate someone's file, and
// a second copy is how the two platforms end up disagreeing about it.
package sftpedit

import (
	"fmt"
	"io"
	"os"
	"path"
	"strings"
	"time"

	sftppkg "github.com/pkg/sftp"
)

const (
	// MaxEditableBytes is a hard cap. Clients may enforce a smaller, configurable
	// limit on top of it.
	MaxEditableBytes = 16 * 1024 * 1024
	binarySniffBytes = 8 * 1024

	// ConflictPrefix marks "the remote changed since it was opened" so callers
	// can offer reload-or-overwrite instead of a generic failure.
	ConflictPrefix = "sftp-conflict:"
)

// LooksBinary reports whether content should be kept out of a text editor. A NUL
// byte in the first 8KB is the same signal git and file(1) use.
func LooksBinary(content []byte) bool {
	sniff := content
	if len(sniff) > binarySniffBytes {
		sniff = sniff[:binarySniffBytes]
	}
	for _, b := range sniff {
		if b == 0x00 {
			return true
		}
	}
	return false
}

// TextFile is a file loaded for editing, with the identity a later save checks
// against to detect a concurrent change.
type TextFile struct {
	Content string `json:"content"`
	Size    int64  `json:"size"`
	Mtime   string `json:"mtime"`
	Mode    int    `json:"mode"`
}

// FormatMtime renders a modification time the way conflict checks compare it.
// Both the read and the save must use the same format or every save conflicts.
func FormatMtime(modTime time.Time) string {
	return modTime.UTC().Format(time.RFC3339)
}

// ReadTextFile loads a file for the editor, rejecting what cannot be edited as
// text: directories, oversized files, and binary content.
func ReadTextFile(client *sftppkg.Client, remotePath string) (TextFile, error) {
	if strings.TrimSpace(remotePath) == "" {
		return TextFile{}, fmt.Errorf("path is required")
	}

	info, err := client.Stat(remotePath)
	if err != nil {
		return TextFile{}, err
	}
	if info.IsDir() {
		return TextFile{}, fmt.Errorf("cannot edit a directory")
	}
	if info.Size() > MaxEditableBytes {
		return TextFile{}, fmt.Errorf("file is too large to edit (%d bytes)", info.Size())
	}

	file, err := client.Open(remotePath)
	if err != nil {
		return TextFile{}, err
	}
	defer file.Close()

	// Read one byte past the cap so a file that grew between Stat and Open is
	// still caught rather than silently truncated into the editor.
	content, err := io.ReadAll(io.LimitReader(file, MaxEditableBytes+1))
	if err != nil {
		return TextFile{}, err
	}
	if int64(len(content)) > MaxEditableBytes {
		return TextFile{}, fmt.Errorf("file is too large to edit")
	}
	if LooksBinary(content) {
		return TextFile{}, fmt.Errorf("file appears to be binary and cannot be edited as text")
	}

	return TextFile{
		Content: string(content),
		Size:    info.Size(),
		Mtime:   FormatMtime(info.ModTime()),
		Mode:    int(info.Mode().Perm()),
	}, nil
}

// ConflictCheck is what the editor remembered when it opened the file. A nil
// field is "don't check that one"; Force skips the check entirely.
type ConflictCheck struct {
	ExpectedSize  *int64
	ExpectedMtime string
	Force         bool
}

// CheckConflict reports ConflictPrefix-tagged error when the remote no longer
// matches what the editor opened.
func CheckConflict(info os.FileInfo, statErr error, check ConflictCheck) error {
	if statErr != nil || check.Force {
		return nil
	}
	if check.ExpectedSize != nil && info.Size() != *check.ExpectedSize {
		return fmt.Errorf("%s remote file changed since it was opened", ConflictPrefix)
	}
	if check.ExpectedMtime != "" && FormatMtime(info.ModTime()) != check.ExpectedMtime {
		return fmt.Errorf("%s remote file changed since it was opened", ConflictPrefix)
	}
	return nil
}

// ResolveMode picks the permission bits a save should land with: an explicit
// request wins, otherwise the file keeps the mode it already had.
func ResolveMode(requestedMode int, info os.FileInfo, statErr error) os.FileMode {
	switch {
	case requestedMode != 0:
		return os.FileMode(requestedMode).Perm()
	case statErr == nil:
		return info.Mode().Perm()
	default:
		return os.FileMode(0o644)
	}
}

// AtomicWrite writes content to a sibling temp file then renames it over the
// target, so an interrupted write never truncates the original. It needs only
// directory write permission.
func AtomicWrite(
	client *sftppkg.Client,
	targetPath string,
	content []byte,
	mode os.FileMode,
	preserveMtime bool,
	info os.FileInfo,
	statErr error,
) error {
	dir := path.Dir(targetPath)
	tmpPath := path.Join(dir, "."+path.Base(targetPath)+".dolgate-tmp")
	_ = client.Remove(tmpPath)

	file, err := client.Create(tmpPath)
	if err != nil {
		return err
	}
	if _, err := file.Write(content); err != nil {
		_ = file.Close()
		_ = client.Remove(tmpPath)
		return err
	}
	if err := file.Close(); err != nil {
		_ = client.Remove(tmpPath)
		return err
	}
	if err := client.Chmod(tmpPath, mode); err != nil {
		_ = client.Remove(tmpPath)
		return err
	}
	if preserveMtime && statErr == nil {
		_ = client.Chtimes(tmpPath, time.Now(), info.ModTime())
	}
	if err := client.PosixRename(tmpPath, targetPath); err != nil {
		// Servers without the posix-rename extension: best-effort fallback.
		if renameErr := client.Rename(tmpPath, targetPath); renameErr != nil {
			_ = client.Remove(tmpPath)
			return renameErr
		}
	}
	return nil
}
