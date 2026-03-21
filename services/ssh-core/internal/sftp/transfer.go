package sftp

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	sftppkg "github.com/pkg/sftp"

	"keyterm/services/ssh-core/internal/protocol"
)

type filesystemAccessor interface {
	Join(base string, elem ...string) string
	Dir(targetPath string) string
	Base(targetPath string) string
	Stat(targetPath string) (os.FileInfo, error)
	ReadDir(targetPath string) ([]os.FileInfo, error)
	Open(targetPath string) (io.ReadCloser, error)
	Create(targetPath string) (io.WriteCloser, error)
	MkdirAll(targetPath string) error
	Remove(targetPath string) error
	RemoveDirectory(targetPath string) error
}

type localFilesystemAccessor struct{}

func (localFilesystemAccessor) Join(base string, elem ...string) string {
	all := append([]string{base}, elem...)
	return filepath.Join(all...)
}

func (localFilesystemAccessor) Dir(targetPath string) string {
	return filepath.Dir(targetPath)
}

func (localFilesystemAccessor) Base(targetPath string) string {
	return filepath.Base(targetPath)
}

func (localFilesystemAccessor) Stat(targetPath string) (os.FileInfo, error) {
	return os.Stat(targetPath)
}

func (localFilesystemAccessor) ReadDir(targetPath string) ([]os.FileInfo, error) {
	entries, err := os.ReadDir(targetPath)
	if err != nil {
		return nil, err
	}
	items := make([]os.FileInfo, 0, len(entries))
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil {
			return nil, err
		}
		items = append(items, info)
	}
	return items, nil
}

func (localFilesystemAccessor) Open(targetPath string) (io.ReadCloser, error) {
	return os.Open(targetPath)
}

func (localFilesystemAccessor) Create(targetPath string) (io.WriteCloser, error) {
	return os.Create(targetPath)
}

func (localFilesystemAccessor) MkdirAll(targetPath string) error {
	return os.MkdirAll(targetPath, 0o755)
}

func (localFilesystemAccessor) Remove(targetPath string) error {
	return os.Remove(targetPath)
}

func (localFilesystemAccessor) RemoveDirectory(targetPath string) error {
	return os.Remove(targetPath)
}

type remoteFilesystemAccessor struct {
	client *sftppkg.Client
}

func (accessor remoteFilesystemAccessor) Join(base string, elem ...string) string {
	all := append([]string{base}, elem...)
	return path.Join(all...)
}

func (accessor remoteFilesystemAccessor) Dir(targetPath string) string {
	return path.Dir(targetPath)
}

func (accessor remoteFilesystemAccessor) Base(targetPath string) string {
	return path.Base(targetPath)
}

func (accessor remoteFilesystemAccessor) Stat(targetPath string) (os.FileInfo, error) {
	return accessor.client.Stat(targetPath)
}

func (accessor remoteFilesystemAccessor) ReadDir(targetPath string) ([]os.FileInfo, error) {
	return accessor.client.ReadDir(targetPath)
}

func (accessor remoteFilesystemAccessor) Open(targetPath string) (io.ReadCloser, error) {
	return accessor.client.Open(targetPath)
}

func (accessor remoteFilesystemAccessor) Create(targetPath string) (io.WriteCloser, error) {
	return accessor.client.Create(targetPath)
}

func (accessor remoteFilesystemAccessor) MkdirAll(targetPath string) error {
	return accessor.client.MkdirAll(targetPath)
}

func (accessor remoteFilesystemAccessor) Remove(targetPath string) error {
	return accessor.client.Remove(targetPath)
}

func (accessor remoteFilesystemAccessor) RemoveDirectory(targetPath string) error {
	return accessor.client.RemoveDirectory(targetPath)
}

type transferProgress struct {
	startedAt      time.Time
	bytesTotal     int64
	bytesCompleted int64
	activeItemName string
}

func (progress *transferProgress) snapshot(status string, activeItemName string, message string) protocol.SFTPTransferProgressPayload {
	speed := 0.0
	etaSeconds := int64(0)
	elapsedSeconds := time.Since(progress.startedAt).Seconds()
	if elapsedSeconds > 0 {
		speed = float64(progress.bytesCompleted) / elapsedSeconds
	}
	if speed > 0 && progress.bytesCompleted < progress.bytesTotal {
		etaSeconds = int64(float64(progress.bytesTotal-progress.bytesCompleted) / speed)
	}

	if activeItemName == "" {
		activeItemName = progress.activeItemName
	}

	return protocol.SFTPTransferProgressPayload{
		Status:              status,
		BytesTotal:          progress.bytesTotal,
		BytesCompleted:      progress.bytesCompleted,
		ActiveItemName:      activeItemName,
		SpeedBytesPerSecond: speed,
		ETASeconds:          etaSeconds,
		Message:             message,
	}
}

func calculateTotalSize(ctx context.Context, accessor filesystemAccessor, targetPath string) (int64, error) {
	select {
	case <-ctx.Done():
		return 0, ctx.Err()
	default:
	}

	info, err := accessor.Stat(targetPath)
	if err != nil {
		return 0, err
	}
	if !info.IsDir() {
		return info.Size(), nil
	}

	entries, err := accessor.ReadDir(targetPath)
	if err != nil {
		return 0, err
	}

	total := int64(0)
	for _, entry := range entries {
		size, err := calculateTotalSize(ctx, accessor, accessor.Join(targetPath, entry.Name()))
		if err != nil {
			return 0, err
		}
		total += size
	}
	return total, nil
}

func prepareDestination(
	targetFS filesystemAccessor,
	sourceInfo os.FileInfo,
	targetPath string,
	conflictResolution string,
) (string, bool, bool, error) {
	existing, err := targetFS.Stat(targetPath)
	if err != nil {
		if isNotExist(err) {
			return targetPath, false, false, nil
		}
		return "", false, false, err
	}

	switch conflictResolution {
	case "skip":
		return targetPath, true, false, nil
	case "keepBoth":
		uniquePath, err := nextUniquePath(targetFS, targetPath)
		return uniquePath, false, false, err
	case "overwrite", "":
		if sourceInfo.IsDir() && existing.IsDir() {
			return targetPath, false, true, nil
		}
		if err := removePath(targetFS, targetPath); err != nil {
			return "", false, false, err
		}
		return targetPath, false, false, nil
	default:
		return "", false, false, fmt.Errorf("unsupported conflict resolution: %s", conflictResolution)
	}
}

func nextUniquePath(targetFS filesystemAccessor, targetPath string) (string, error) {
	parentDir := targetFS.Dir(targetPath)
	baseName := targetFS.Base(targetPath)

	rootName := baseName
	extension := ""
	if dotIndex := strings.LastIndex(baseName, "."); dotIndex > 0 {
		rootName = baseName[:dotIndex]
		extension = baseName[dotIndex:]
	}

	for index := 1; index < 1000; index++ {
		suffix := " copy"
		if index > 1 {
			suffix = fmt.Sprintf(" copy %d", index)
		}
		candidate := targetFS.Join(parentDir, rootName+suffix+extension)
		if _, err := targetFS.Stat(candidate); isNotExist(err) {
			return candidate, nil
		} else if err != nil {
			return "", err
		}
	}

	return "", fmt.Errorf("failed to derive a unique name for %s", targetPath)
}

func removePath(accessor filesystemAccessor, targetPath string) error {
	info, err := accessor.Stat(targetPath)
	if err != nil {
		if isNotExist(err) {
			return nil
		}
		return err
	}
	if !info.IsDir() {
		return accessor.Remove(targetPath)
	}

	entries, err := accessor.ReadDir(targetPath)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if err := removePath(accessor, accessor.Join(targetPath, entry.Name())); err != nil {
			return err
		}
	}
	return accessor.RemoveDirectory(targetPath)
}

func copyFileWithProgress(
	ctx context.Context,
	jobID string,
	progress *transferProgress,
	emit func(protocol.Event),
	sourceFS filesystemAccessor,
	targetFS filesystemAccessor,
	sourcePath string,
	targetPath string,
) error {
	if err := targetFS.MkdirAll(targetFS.Dir(targetPath)); err != nil {
		return err
	}

	sourceFile, err := sourceFS.Open(sourcePath)
	if err != nil {
		return err
	}
	defer sourceFile.Close()

	targetFile, err := targetFS.Create(targetPath)
	if err != nil {
		return err
	}
	defer targetFile.Close()

	buffer := make([]byte, 128*1024)
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		readBytes, err := sourceFile.Read(buffer)
		if readBytes > 0 {
			writtenBytes, writeErr := targetFile.Write(buffer[:readBytes])
			if writeErr != nil {
				return writeErr
			}
			if writtenBytes != readBytes {
				return io.ErrShortWrite
			}

			progress.bytesCompleted += int64(writtenBytes)
			emit(protocol.Event{
				Type:    protocol.EventSFTPTransferProgress,
				JobID:   jobID,
				Payload: progress.snapshot("running", sourceFS.Base(sourcePath), ""),
			})
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

func isNotExist(err error) bool {
	if err == nil {
		return false
	}
	return errors.Is(err, os.ErrNotExist) || os.IsNotExist(err)
}
