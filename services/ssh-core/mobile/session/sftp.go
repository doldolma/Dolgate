package session

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"sync"
	"time"

	sftppkg "github.com/pkg/sftp"

	"dolssh/services/ssh-core/pkg/coretypes"
)

// ErrSFTPClosed is returned once an SFTP session has been closed.
var ErrSFTPClosed = errors.New("sftp session is closed")

// SFTP is a file-transfer session riding on an established connection.
//
// The desktop engine's internal/sftp is not reused here: it is built around
// pushing progress events out over the stdio protocol, while the app drives
// transfers itself and only needs request/response. What is shared is the wire
// vocabulary — entries are coretypes.SFTPFileEntry, the same records the desktop
// sends — and the way those entries are filled in, so a directory looks
// identical on both platforms.
type SFTP struct {
	client *sftppkg.Client

	mu     sync.Mutex
	closed bool
}

// StartSFTP opens an SFTP session on the connection.
func (c *Conn) StartSFTP() (*SFTP, error) {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil, ErrConnClosed
	}
	c.mu.Unlock()

	client, err := sftppkg.NewClient(c.client)
	if err != nil {
		return nil, fmt.Errorf("open sftp session: %w", err)
	}
	return &SFTP{client: client}, nil
}

// List returns the entries of a directory.
func (s *SFTP) List(dir string) (coretypes.SFTPListedPayload, error) {
	client, err := s.use()
	if err != nil {
		return coretypes.SFTPListedPayload{}, err
	}

	items, err := client.ReadDir(dir)
	if err != nil {
		return coretypes.SFTPListedPayload{}, fmt.Errorf("list %s: %w", dir, err)
	}

	entries := make([]coretypes.SFTPFileEntry, 0, len(items))
	for _, item := range items {
		entries = append(entries, toFileEntry(dir, item))
	}
	return coretypes.SFTPListedPayload{Path: dir, Entries: entries}, nil
}

// ReadChunk reads up to length bytes at offset. The returned eof reports that
// the read reached the end of the file, which is how the app knows to stop
// without a separate stat call.
func (s *SFTP) ReadChunk(remotePath string, offset int64, length int) (data []byte, eof bool, err error) {
	client, err := s.use()
	if err != nil {
		return nil, false, err
	}
	if length <= 0 {
		return nil, false, fmt.Errorf("read length must be positive, got %d", length)
	}

	file, err := client.Open(remotePath)
	if err != nil {
		return nil, false, fmt.Errorf("open %s: %w", remotePath, err)
	}
	defer file.Close()

	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		return nil, false, fmt.Errorf("seek %s: %w", remotePath, err)
	}

	buf := make([]byte, length)
	// ReadFull rather than Read: a short read mid-file is normal for SFTP and
	// would otherwise look like the end of the file to the caller.
	read, err := io.ReadFull(file, buf)
	switch {
	case err == nil:
		return buf[:read], false, nil
	case errors.Is(err, io.EOF), errors.Is(err, io.ErrUnexpectedEOF):
		return buf[:read], true, nil
	default:
		return nil, false, fmt.Errorf("read %s: %w", remotePath, err)
	}
}

// WriteChunk writes data at offset, creating the file when it does not exist.
func (s *SFTP) WriteChunk(remotePath string, offset int64, data []byte) error {
	client, err := s.use()
	if err != nil {
		return err
	}

	// Opened without O_TRUNC so successive chunks of one upload append to the
	// same file rather than each replacing it.
	file, err := client.OpenFile(remotePath, os.O_WRONLY|os.O_CREATE)
	if err != nil {
		return fmt.Errorf("open %s for writing: %w", remotePath, err)
	}
	defer file.Close()

	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		return fmt.Errorf("seek %s: %w", remotePath, err)
	}
	if _, err := file.Write(data); err != nil {
		return fmt.Errorf("write %s: %w", remotePath, err)
	}
	return nil
}

// Mkdir creates a directory.
func (s *SFTP) Mkdir(dir string) error {
	client, err := s.use()
	if err != nil {
		return err
	}
	if err := client.Mkdir(dir); err != nil {
		return fmt.Errorf("mkdir %s: %w", dir, err)
	}
	return nil
}

// Rename moves a file or directory.
func (s *SFTP) Rename(sourcePath, targetPath string) error {
	client, err := s.use()
	if err != nil {
		return err
	}
	if err := client.Rename(sourcePath, targetPath); err != nil {
		return fmt.Errorf("rename %s: %w", sourcePath, err)
	}
	return nil
}

// Chmod changes permission bits.
func (s *SFTP) Chmod(remotePath string, mode uint32) error {
	client, err := s.use()
	if err != nil {
		return err
	}
	if err := client.Chmod(remotePath, os.FileMode(mode)); err != nil {
		return fmt.Errorf("chmod %s: %w", remotePath, err)
	}
	return nil
}

// Remove deletes a file, or an empty directory.
//
// Recursive deletion is left to the caller: it already walks the tree to report
// progress, and doing it here would duplicate that with no way to report.
func (s *SFTP) Remove(remotePath string) error {
	client, err := s.use()
	if err != nil {
		return err
	}

	info, statErr := client.Stat(remotePath)
	if statErr == nil && info.IsDir() {
		if err := client.RemoveDirectory(remotePath); err != nil {
			return fmt.Errorf("remove directory %s: %w", remotePath, err)
		}
		return nil
	}

	if err := client.Remove(remotePath); err != nil {
		return fmt.Errorf("remove %s: %w", remotePath, err)
	}
	return nil
}

// Stat reports one entry, for confirming a transfer landed.
func (s *SFTP) Stat(remotePath string) (coretypes.SFTPFileEntry, error) {
	client, err := s.use()
	if err != nil {
		return coretypes.SFTPFileEntry{}, err
	}

	info, err := client.Stat(remotePath)
	if err != nil {
		return coretypes.SFTPFileEntry{}, fmt.Errorf("stat %s: %w", remotePath, err)
	}
	return toFileEntry(path.Dir(remotePath), info), nil
}

// Close ends the SFTP session. It is idempotent.
func (s *SFTP) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	s.mu.Unlock()

	if err := s.client.Close(); err != nil && !isClosedErr(err) {
		return fmt.Errorf("close sftp session: %w", err)
	}
	return nil
}

func (s *SFTP) use() (*sftppkg.Client, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, ErrSFTPClosed
	}
	return s.client, nil
}

// toFileEntry fills in an entry the same way the desktop engine's
// internal/sftp does, so the browser renders both identically.
func toFileEntry(parentPath string, item os.FileInfo) coretypes.SFTPFileEntry {
	kind := "unknown"
	switch {
	case item.IsDir():
		kind = "folder"
	case item.Mode()&os.ModeSymlink != 0:
		kind = "symlink"
	case item.Mode().IsRegular():
		kind = "file"
	}

	entry := coretypes.SFTPFileEntry{
		Name:        item.Name(),
		Path:        path.Join(parentPath, item.Name()),
		IsDirectory: item.IsDir(),
		Size:        item.Size(),
		Mtime:       item.ModTime().UTC().Format(time.RFC3339),
		Kind:        kind,
		Permissions: item.Mode().String(),
	}

	// Ownership only comes through when the server reports it; the app shows the
	// numeric ids and leaves name resolution to the desktop, which has the
	// passwd/group lookup.
	if stat, ok := item.Sys().(*sftppkg.FileStat); ok && stat != nil {
		uid := int(stat.UID)
		gid := int(stat.GID)
		entry.UID = &uid
		entry.GID = &gid
	}

	return entry
}
