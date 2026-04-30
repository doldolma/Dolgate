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

const (
	transferErrorPermissionDenied     = "permission_denied"
	transferErrorNotFound             = "not_found"
	transferErrorOperationUnsupported = "operation_unsupported"
	transferErrorConnectionLost       = "connection_lost"
	transferErrorUnknown              = "unknown"
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
	Rename(oldPath string, newPath string) error
	Chtimes(targetPath string, atime time.Time, mtime time.Time) error
	Chmod(targetPath string, mode os.FileMode) error
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

func (localFilesystemAccessor) Rename(oldPath string, newPath string) error {
	return os.Rename(oldPath, newPath)
}

func (localFilesystemAccessor) Chtimes(targetPath string, atime time.Time, mtime time.Time) error {
	return os.Chtimes(targetPath, atime, mtime)
}

func (localFilesystemAccessor) Chmod(targetPath string, mode os.FileMode) error {
	return os.Chmod(targetPath, mode)
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

func (accessor remoteFilesystemAccessor) Rename(oldPath string, newPath string) error {
	return accessor.client.Rename(oldPath, newPath)
}

func (accessor remoteFilesystemAccessor) Chtimes(targetPath string, atime time.Time, mtime time.Time) error {
	return accessor.client.Chtimes(targetPath, atime, mtime)
}

func (accessor remoteFilesystemAccessor) Chmod(targetPath string, mode os.FileMode) error {
	return accessor.client.Chmod(targetPath, mode)
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

type transferMetadataOptions struct {
	preserveMtime       bool
	preservePermissions bool
}

type transferPauseController struct {
	mu       sync.Mutex
	paused   bool
	resumeCh chan struct{}
}

func newTransferPauseController() *transferPauseController {
	return &transferPauseController{}
}

func (controller *transferPauseController) Pause() {
	controller.mu.Lock()
	defer controller.mu.Unlock()
	if controller.paused {
		return
	}
	controller.paused = true
	controller.resumeCh = make(chan struct{})
}

func (controller *transferPauseController) Resume() {
	controller.mu.Lock()
	defer controller.mu.Unlock()
	if !controller.paused {
		return
	}
	close(controller.resumeCh)
	controller.paused = false
	controller.resumeCh = nil
}

func (controller *transferPauseController) Wait(ctx context.Context) error {
	for {
		controller.mu.Lock()
		if !controller.paused {
			controller.mu.Unlock()
			return nil
		}
		resumeCh := controller.resumeCh
		controller.mu.Unlock()

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-resumeCh:
		}
	}
}

type transferCleanupTracker struct {
	mu      sync.Mutex
	paths   map[string]string
	cleanup func(string)
}

func newTransferCleanupTracker(cleanup func(string)) *transferCleanupTracker {
	return &transferCleanupTracker{
		paths:   make(map[string]string),
		cleanup: cleanup,
	}
}

func (tracker *transferCleanupTracker) Add(targetPath string) {
	if targetPath == "" {
		return
	}
	tracker.mu.Lock()
	tracker.paths[targetPath] = targetPath
	tracker.mu.Unlock()
}

func (tracker *transferCleanupTracker) Remove(targetPath string) {
	tracker.mu.Lock()
	delete(tracker.paths, targetPath)
	tracker.mu.Unlock()
}

func (tracker *transferCleanupTracker) CleanupAll() {
	tracker.mu.Lock()
	paths := make([]string, 0, len(tracker.paths))
	for targetPath := range tracker.paths {
		paths = append(paths, targetPath)
	}
	tracker.paths = make(map[string]string)
	tracker.mu.Unlock()

	for _, targetPath := range paths {
		tracker.cleanup(targetPath)
	}
}

type transferError struct {
	Code      string
	Operation string
	Path      string
	ItemName  string
	Detail    string
	Cause     error
}

func (err *transferError) Error() string {
	if err.Detail != "" {
		return err.Detail
	}
	if err.Cause != nil {
		return err.Cause.Error()
	}
	return "sftp transfer failed"
}

func (err *transferError) Unwrap() error {
	return err.Cause
}

func annotateTransferError(operation string, targetPath string, err error) error {
	if err == nil {
		return nil
	}
	var existing *transferError
	if errors.As(err, &existing) {
		next := *existing
		if next.Operation == "" {
			next.Operation = operation
		}
		if next.Path == "" {
			next.Path = targetPath
		}
		if next.Code == "" {
			next.Code = classifyTransferError(err)
		}
		if next.Detail == "" {
			next.Detail = err.Error()
		}
		return &next
	}
	return &transferError{
		Code:      classifyTransferError(err),
		Operation: operation,
		Path:      targetPath,
		Detail:    err.Error(),
		Cause:     err,
	}
}

func annotateTransferItem(err error, itemName string) error {
	if err == nil || itemName == "" {
		return err
	}
	var existing *transferError
	if errors.As(err, &existing) {
		next := *existing
		if next.ItemName == "" {
			next.ItemName = itemName
		}
		return &next
	}
	return &transferError{
		Code:     classifyTransferError(err),
		ItemName: itemName,
		Detail:   err.Error(),
		Cause:    err,
	}
}

func classifyTransferError(err error) string {
	if err == nil {
		return transferErrorUnknown
	}
	var existing *transferError
	if errors.As(err, &existing) && existing.Code != "" {
		return existing.Code
	}
	var statusErr *sftppkg.StatusError
	if errors.As(err, &statusErr) {
		switch statusErr.Code {
		case 2:
			return transferErrorNotFound
		case 3:
			return transferErrorPermissionDenied
		case 6, 7:
			return transferErrorConnectionLost
		case 8:
			return transferErrorOperationUnsupported
		default:
			return transferErrorUnknown
		}
	}
	if errors.Is(err, os.ErrPermission) || os.IsPermission(err) {
		return transferErrorPermissionDenied
	}
	if errors.Is(err, os.ErrNotExist) || os.IsNotExist(err) {
		return transferErrorNotFound
	}

	message := strings.ToLower(err.Error())
	switch {
	case strings.Contains(message, "permission denied") ||
		strings.Contains(message, "eacces") ||
		strings.Contains(message, "eperm") ||
		strings.Contains(message, "ssh_fx_permission_denied"):
		return transferErrorPermissionDenied
	case strings.Contains(message, "no such file") ||
		strings.Contains(message, "not found") ||
		strings.Contains(message, "ssh_fx_no_such_file"):
		return transferErrorNotFound
	case strings.Contains(message, "operation unsupported") ||
		strings.Contains(message, "unsupported") ||
		strings.Contains(message, "ssh_fx_op_unsupported"):
		return transferErrorOperationUnsupported
	case strings.Contains(message, "connection lost") ||
		strings.Contains(message, "no connection") ||
		strings.Contains(message, "connection reset") ||
		strings.Contains(message, "use of closed network connection"):
		return transferErrorConnectionLost
	default:
		return transferErrorUnknown
	}
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

func (reporter *transferProgressReporter) emitPaused(
	activeItemName string,
	message string,
) {
	payload, _ := reporter.progress.nextSnapshot(
		reporter.now(),
		"paused",
		activeItemName,
		message,
		true,
	)
	reporter.emit(protocol.Event{
		Type:    protocol.EventSFTPTransferProgress,
		JobID:   reporter.jobID,
		Payload: payload,
	})
}

func (reporter *transferProgressReporter) emitPartialPath(
	activeItemName string,
	partialPath string,
) {
	payload, _ := reporter.progress.nextSnapshot(
		reporter.now(),
		"running",
		activeItemName,
		"",
		true,
	)
	payload.PartialPath = partialPath
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
	reader         io.Reader
	onRead         func(int64)
	errorOperation string
	errorPath      string
}

func (reader *countingReader) Read(buffer []byte) (int, error) {
	readBytes, err := reader.reader.Read(buffer)
	if readBytes > 0 && reader.onRead != nil {
		reader.onRead(int64(readBytes))
	}
	if err != nil && !errors.Is(err, io.EOF) && reader.errorOperation != "" {
		return readBytes, annotateTransferError(reader.errorOperation, reader.errorPath, err)
	}
	return readBytes, err
}

type countingWriter struct {
	writer         io.Writer
	onWrite        func(int64)
	errorOperation string
	errorPath      string
}

func (writer *countingWriter) Write(buffer []byte) (int, error) {
	writtenBytes, err := writer.writer.Write(buffer)
	if writtenBytes > 0 && writer.onWrite != nil {
		writer.onWrite(int64(writtenBytes))
	}
	if err != nil && writer.errorOperation != "" {
		return writtenBytes, annotateTransferError(writer.errorOperation, writer.errorPath, err)
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
		return 0, annotateTransferError("source_stat", targetPath, err)
	}
	if !info.IsDir() {
		return info.Size(), nil
	}

	entries, err := accessor.ReadDir(targetPath)
	if err != nil {
		return 0, annotateTransferError("source_list", targetPath, err)
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
) (string, bool, bool, bool, error) {
	existing, err := targetFS.Stat(targetPath)
	if err != nil {
		if isNotExist(err) {
			return targetPath, false, false, false, nil
		}
		return "", false, false, false, annotateTransferError("target_stat", targetPath, err)
	}

	switch conflictResolution {
	case "skip":
		return targetPath, true, false, false, nil
	case "keepBoth":
		uniquePath, err := nextUniquePath(targetFS, targetPath)
		if err != nil {
			return "", false, false, false, annotateTransferError("target_stat", targetPath, err)
		}
		return uniquePath, false, false, false, nil
	case "overwrite", "":
		if sourceInfo.IsDir() && existing.IsDir() {
			return targetPath, false, true, false, nil
		}
		if !sourceInfo.IsDir() {
			return targetPath, false, false, true, nil
		}
		if err := removePath(targetFS, targetPath); err != nil {
			return "", false, false, false, annotateTransferError("target_remove", targetPath, err)
		}
		return targetPath, false, false, false, nil
	default:
		return "", false, false, false, fmt.Errorf("unsupported conflict resolution: %s", conflictResolution)
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
	jobID string,
	pauseController *transferPauseController,
	metadata transferMetadataOptions,
	sourceInfo os.FileInfo,
	replaceExisting bool,
	cleanupTracker *transferCleanupTracker,
	reporter *transferProgressReporter,
) error {
	if err := targetFS.MkdirAll(targetFS.Dir(targetPath)); err != nil {
		return annotateTransferError("target_mkdir", targetFS.Dir(targetPath), err)
	}
	if err := pauseController.Wait(ctx); err != nil {
		return err
	}

	sourceFile, err := sourceFS.Open(sourcePath)
	if err != nil {
		return annotateTransferError("source_open", sourcePath, err)
	}

	partialPath := buildPartialTransferPath(targetFS, targetPath, jobID)
	if partialPath == "" || partialPath == targetPath {
		partialPath = targetPath
	}
	if partialPath != targetPath {
		_ = targetFS.Remove(partialPath)
		cleanupTracker.Add(partialPath)
		reporter.emitPartialPath(sourceFS.Base(sourcePath), partialPath)
	}

	targetFile, err := targetFS.Create(partialPath)
	if err != nil {
		_ = sourceFile.Close()
		return annotateTransferError("target_create", partialPath, err)
	}

	closer := newTransferStreamCloser(sourceFile, targetFile)
	defer closer.Close()

	stopCancellationWatcher := watchTransferCancellation(ctx, closer)
	defer stopCancellationWatcher()

	if err := transferFileContentsWithControl(
		ctx,
		sourceFile,
		targetFile,
		pauseController,
		reporter,
		sourcePath,
		partialPath,
	); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if partialPath != targetPath {
			_ = targetFS.Remove(partialPath)
			cleanupTracker.Remove(partialPath)
		}
		return annotateTransferError("target_write", partialPath, err)
	}
	if ctx.Err() != nil {
		if partialPath != targetPath {
			_ = targetFS.Remove(partialPath)
			cleanupTracker.Remove(partialPath)
		}
		return ctx.Err()
	}
	closer.Close()

	metadataErr := applyTransferMetadata(targetFS, partialPath, sourceInfo, metadata)
	if metadataErr != nil && metadata.preservePermissions {
		// Metadata preservation is best-effort. Keep the transferred file and
		// surface the path in the detail message if a future caller wants it.
		_ = metadataErr
	}

	if partialPath == targetPath {
		return nil
	}
	if replaceExisting {
		if err := removePath(targetFS, targetPath); err != nil {
			return annotateTransferError("target_remove", targetPath, err)
		}
	}
	if err := targetFS.Rename(partialPath, targetPath); err != nil {
		return annotateTransferError("target_rename", targetPath, err)
	}
	cleanupTracker.Remove(partialPath)
	return nil
}

func buildPartialTransferPath(targetFS filesystemAccessor, targetPath string, jobID string) string {
	baseName := targetFS.Base(targetPath)
	if baseName == "" || baseName == "." || baseName == "/" {
		return ""
	}
	suffix := sanitizePartialTransferID(jobID)
	if suffix == "" {
		suffix = "unknown"
	}
	return targetFS.Join(targetFS.Dir(targetPath), "."+baseName+".dolgate-partial."+suffix)
}

func sanitizePartialTransferID(value string) string {
	var builder strings.Builder
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			builder.WriteRune(r)
		}
	}
	return builder.String()
}

func applyTransferMetadata(
	targetFS filesystemAccessor,
	targetPath string,
	sourceInfo os.FileInfo,
	options transferMetadataOptions,
) error {
	if options.preservePermissions {
		if err := targetFS.Chmod(targetPath, sourceInfo.Mode().Perm()); err != nil {
			return annotateTransferError("target_chmod", targetPath, err)
		}
	}
	if options.preserveMtime {
		modTime := sourceInfo.ModTime()
		if err := targetFS.Chtimes(targetPath, modTime, modTime); err != nil {
			return annotateTransferError("target_chtime", targetPath, err)
		}
	}
	return nil
}

func transferFileContentsWithControl(
	ctx context.Context,
	sourceFile io.ReadCloser,
	targetFile io.WriteCloser,
	pauseController *transferPauseController,
	reporter *transferProgressReporter,
	sourcePath string,
	targetPath string,
) error {
	buffer := make([]byte, transferFallbackBufferSize)
	for {
		if err := pauseController.Wait(ctx); err != nil {
			return err
		}
		readBytes, readErr := sourceFile.Read(buffer)
		if readBytes > 0 {
			if err := pauseController.Wait(ctx); err != nil {
				return err
			}
			writtenBytes, writeErr := targetFile.Write(buffer[:readBytes])
			if writtenBytes > 0 {
				reporter.recordTransferredBytes(int64(writtenBytes))
			}
			if writeErr != nil {
				return annotateTransferError("target_write", targetPath, writeErr)
			}
			if writtenBytes != readBytes {
				return annotateTransferError("target_write", targetPath, io.ErrShortWrite)
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				return nil
			}
			return annotateTransferError("source_read", sourcePath, readErr)
		}
	}
}

func transferFileContents(
	sourceFile io.ReadCloser,
	targetFile io.WriteCloser,
	reporter *transferProgressReporter,
	sourcePath string,
	targetPath string,
) error {
	if concurrentTarget, ok := targetFile.(concurrentReaderFrom); ok {
		writtenBytes, err := concurrentTarget.ReadFromWithConcurrency(
			&countingReader{
				reader:         sourceFile,
				onRead:         reporter.recordTransferredBytes,
				errorOperation: "source_read",
				errorPath:      sourcePath,
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
		writer:         targetFile,
		onWrite:        reporter.recordTransferredBytes,
		errorOperation: "target_write",
		errorPath:      targetPath,
	}

	if writerToSource, ok := sourceFile.(io.WriterTo); ok {
		_, err := writerToSource.WriteTo(progressWriter)
		return annotateTransferError("source_read", sourcePath, err)
	}

	progressReader := &countingReader{
		reader:         sourceFile,
		errorOperation: "source_read",
		errorPath:      sourcePath,
	}

	_, err := io.CopyBuffer(
		progressWriter,
		progressReader,
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
