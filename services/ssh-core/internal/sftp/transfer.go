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
	"sync"
	"time"

	sftppkg "github.com/pkg/sftp"

	"dolssh/services/ssh-core/internal/protocol"
)

const (
	transferConcurrentRequestsPerFile = 128
	transferFallbackBufferSize        = 1024 * 1024
	transferProgressEmitInterval      = 250 * time.Millisecond
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
	mu                        sync.Mutex
	startedAt                 time.Time
	bytesTotal                int64
	bytesCompleted            int64
	activeItemName            string
	lastEmittedAt             time.Time
	lastEmittedBytesCompleted int64
	lastEmittedItemName       string
}

func newTransferProgress(now time.Time) *transferProgress {
	return &transferProgress{
		startedAt: now,
	}
}

func (progress *transferProgress) addBytesCompleted(bytes int64) {
	progress.mu.Lock()
	progress.bytesCompleted += bytes
	progress.mu.Unlock()
}

func (progress *transferProgress) nextSnapshot(
	now time.Time,
	status string,
	activeItemName string,
	message string,
	force bool,
) (protocol.SFTPTransferProgressPayload, bool) {
	progress.mu.Lock()
	defer progress.mu.Unlock()

	if activeItemName == "" {
		activeItemName = progress.activeItemName
	} else {
		progress.activeItemName = activeItemName
	}

	if status == "running" && !force && !progress.lastEmittedAt.IsZero() {
		if now.Sub(progress.lastEmittedAt) < transferProgressEmitInterval &&
			activeItemName == progress.lastEmittedItemName {
			return protocol.SFTPTransferProgressPayload{}, false
		}
	}

	speed := 0.0
	etaSeconds := int64(0)
	if !progress.lastEmittedAt.IsZero() {
		elapsedSeconds := now.Sub(progress.lastEmittedAt).Seconds()
		if elapsedSeconds > 0 {
			deltaBytes := progress.bytesCompleted - progress.lastEmittedBytesCompleted
			if deltaBytes < 0 {
				deltaBytes = 0
			}
			speed = float64(deltaBytes) / elapsedSeconds
		}
	}
	if speed > 0 && progress.bytesCompleted < progress.bytesTotal {
		etaSeconds = int64(float64(progress.bytesTotal-progress.bytesCompleted) / speed)
	}

	progress.lastEmittedAt = now
	progress.lastEmittedBytesCompleted = progress.bytesCompleted
	progress.lastEmittedItemName = activeItemName

	return protocol.SFTPTransferProgressPayload{
		Status:              status,
		BytesTotal:          progress.bytesTotal,
		BytesCompleted:      progress.bytesCompleted,
		ActiveItemName:      activeItemName,
		SpeedBytesPerSecond: speed,
		ETASeconds:          etaSeconds,
		Message:             message,
	}, true
}

type transferProgressReporter struct {
	jobID    string
	progress *transferProgress
	emit     func(protocol.Event)
	now      func() time.Time
}

func newTransferProgressReporter(
	jobID string,
	progress *transferProgress,
	emit func(protocol.Event),
	now func() time.Time,
) *transferProgressReporter {
	return &transferProgressReporter{
		jobID:    jobID,
		progress: progress,
		emit:     emit,
		now:      now,
	}
}

func (reporter *transferProgressReporter) emitRunning(
	activeItemName string,
	message string,
	force bool,
) {
	payload, shouldEmit := reporter.progress.nextSnapshot(
		reporter.now(),
		"running",
		activeItemName,
		message,
		force,
	)
	if !shouldEmit {
		return
	}
	reporter.emit(protocol.Event{
		Type:    protocol.EventSFTPTransferProgress,
		JobID:   reporter.jobID,
		Payload: payload,
	})
}

func (reporter *transferProgressReporter) emitTerminal(
	eventType protocol.EventType,
	status string,
	activeItemName string,
	message string,
) {
	payload, _ := reporter.progress.nextSnapshot(
		reporter.now(),
		status,
		activeItemName,
		message,
		true,
	)
	reporter.emit(protocol.Event{
		Type:    eventType,
		JobID:   reporter.jobID,
		Payload: payload,
	})
}

func (reporter *transferProgressReporter) recordTransferredBytes(bytes int64) {
	if bytes <= 0 {
		return
	}
	reporter.progress.addBytesCompleted(bytes)
	reporter.emitRunning("", "", false)
}

type concurrentReaderFrom interface {
	ReadFromWithConcurrency(r io.Reader, concurrency int) (int64, error)
}

type truncater interface {
	Truncate(size int64) error
}

type countingReader struct {
	reader io.Reader
	onRead func(int64)
}

func (reader *countingReader) Read(buffer []byte) (int, error) {
	readBytes, err := reader.reader.Read(buffer)
	if readBytes > 0 && reader.onRead != nil {
		reader.onRead(int64(readBytes))
	}
	return readBytes, err
}

type countingWriter struct {
	writer  io.Writer
	onWrite func(int64)
}

func (writer *countingWriter) Write(buffer []byte) (int, error) {
	writtenBytes, err := writer.writer.Write(buffer)
	if writtenBytes > 0 && writer.onWrite != nil {
		writer.onWrite(int64(writtenBytes))
	}
	return writtenBytes, err
}

type transferStreamCloser struct {
	once    sync.Once
	closers []io.Closer
}

func newTransferStreamCloser(closers ...io.Closer) *transferStreamCloser {
	return &transferStreamCloser{closers: closers}
}

func (closer *transferStreamCloser) Close() {
	closer.once.Do(func() {
		for _, handle := range closer.closers {
			if handle != nil {
				_ = handle.Close()
			}
		}
	})
}

func watchTransferCancellation(
	ctx context.Context,
	closer *transferStreamCloser,
) func() {
	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			closer.Close()
		case <-done:
		}
	}()
	return func() {
		close(done)
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
	sourceFS filesystemAccessor,
	targetFS filesystemAccessor,
	sourcePath string,
	targetPath string,
	reporter *transferProgressReporter,
) error {
	if err := targetFS.MkdirAll(targetFS.Dir(targetPath)); err != nil {
		return err
	}

	sourceFile, err := sourceFS.Open(sourcePath)
	if err != nil {
		return err
	}

	targetFile, err := targetFS.Create(targetPath)
	if err != nil {
		_ = sourceFile.Close()
		return err
	}

	closer := newTransferStreamCloser(sourceFile, targetFile)
	defer closer.Close()

	stopCancellationWatcher := watchTransferCancellation(ctx, closer)
	defer stopCancellationWatcher()

	if err := transferFileContents(sourceFile, targetFile, reporter); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return err
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return nil
}

func transferFileContents(
	sourceFile io.ReadCloser,
	targetFile io.WriteCloser,
	reporter *transferProgressReporter,
) error {
	if concurrentTarget, ok := targetFile.(concurrentReaderFrom); ok {
		writtenBytes, err := concurrentTarget.ReadFromWithConcurrency(
			&countingReader{
				reader: sourceFile,
				onRead: reporter.recordTransferredBytes,
			},
			transferConcurrentRequestsPerFile,
		)
		if err != nil {
			if truncatableTarget, ok := targetFile.(truncater); ok && writtenBytes >= 0 {
				_ = truncatableTarget.Truncate(writtenBytes)
			}
			return err
		}
		return nil
	}

	progressWriter := &countingWriter{
		writer:  targetFile,
		onWrite: reporter.recordTransferredBytes,
	}

	if writerToSource, ok := sourceFile.(io.WriterTo); ok {
		_, err := writerToSource.WriteTo(progressWriter)
		return err
	}

	_, err := io.CopyBuffer(
		progressWriter,
		sourceFile,
		make([]byte, transferFallbackBufferSize),
	)
	return err
}

func isNotExist(err error) bool {
	if err == nil {
		return false
	}
	return errors.Is(err, os.ErrNotExist) || os.IsNotExist(err)
}
