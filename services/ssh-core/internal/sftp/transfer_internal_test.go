package sftp

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"testing"
	"time"

	sftppkg "github.com/pkg/sftp"

	"dolssh/services/ssh-core/internal/protocol"
)

func TestTransferProgressReporterEmitsImmediatelyForItemChangesAndThrottlesSamples(t *testing.T) {
	now := time.Unix(0, 0)
	current := now
	emitted := make([]protocol.Event, 0, 4)
	progress := newTransferProgress(now)
	progress.bytesTotal = 1024

	reporter := newTransferProgressReporter(
		"job-1",
		progress,
		func(event protocol.Event) {
			emitted = append(emitted, event)
		},
		func() time.Time { return current },
	)

	reporter.emitRunning("first.bin", "", true)
	if len(emitted) != 1 {
		t.Fatalf("expected initial running event, got %d", len(emitted))
	}

	progress.addBytesCompleted(128)
	current = current.Add(100 * time.Millisecond)
	reporter.emitRunning("second.bin", "", false)
	if len(emitted) != 2 {
		t.Fatalf("expected active-item change to emit immediately, got %d", len(emitted))
	}

	progress.addBytesCompleted(128)
	current = current.Add(100 * time.Millisecond)
	reporter.emitRunning("", "", false)
	if len(emitted) != 2 {
		t.Fatalf("expected throttled running event count to stay at 2, got %d", len(emitted))
	}

	progress.addBytesCompleted(128)
	current = current.Add(300 * time.Millisecond)
	reporter.emitRunning("", "", false)
	if len(emitted) != 3 {
		t.Fatalf("expected throttled running event to emit after interval, got %d", len(emitted))
	}

	payload, ok := emitted[2].Payload.(protocol.SFTPTransferProgressPayload)
	if !ok {
		t.Fatalf("expected transfer payload, got %#v", emitted[2].Payload)
	}
	if payload.ActiveItemName != "second.bin" {
		t.Fatalf("expected active item name to be preserved, got %q", payload.ActiveItemName)
	}
	if payload.SpeedBytesPerSecond <= 0 {
		t.Fatalf("expected positive throughput sample, got %f", payload.SpeedBytesPerSecond)
	}

	current = current.Add(10 * time.Millisecond)
	reporter.emitTerminal(protocol.EventSFTPTransferCancelled, "cancelled", "", "")
	if len(emitted) != 4 {
		t.Fatalf("expected terminal event to bypass throttling, got %d", len(emitted))
	}
}

func TestTransferFileContentsUsesConcurrentRemoteWritePath(t *testing.T) {
	progress := newTransferProgress(time.Unix(0, 0))
	progress.bytesTotal = int64(len("hello over sftp"))
	reporter := newTransferProgressReporter(
		"job-1",
		progress,
		func(protocol.Event) {},
		time.Now,
	)
	target := &fakeConcurrentTarget{}

	if err := transferFileContents(
		&simpleReadCloser{Reader: bytes.NewBufferString("hello over sftp")},
		target,
		reporter,
		"/source.txt",
		"/target.txt",
	); err != nil {
		t.Fatalf("transferFileContents returned error: %v", err)
	}

	if !target.readFromCalled {
		t.Fatalf("expected concurrent remote write path to be used")
	}
	if target.concurrency != transferConcurrentRequestsPerFile {
		t.Fatalf("expected concurrency %d, got %d", transferConcurrentRequestsPerFile, target.concurrency)
	}
	if target.buffer.String() != "hello over sftp" {
		t.Fatalf("unexpected transferred content: %q", target.buffer.String())
	}
}

func TestTransferFileContentsUsesWriterToDownloadPath(t *testing.T) {
	progress := newTransferProgress(time.Unix(0, 0))
	progress.bytesTotal = int64(len("download me"))
	reporter := newTransferProgressReporter(
		"job-1",
		progress,
		func(protocol.Event) {},
		time.Now,
	)
	source := &writerToReadCloser{content: []byte("download me")}
	target := &bufferWriteCloser{}

	if err := transferFileContents(source, target, reporter, "/remote/download.txt", "/local/download.txt"); err != nil {
		t.Fatalf("transferFileContents returned error: %v", err)
	}

	if !source.writeToCalled {
		t.Fatalf("expected writer-to download path to be used")
	}
	if target.buffer.String() != "download me" {
		t.Fatalf("unexpected transferred content: %q", target.buffer.String())
	}
}

func TestTransferFileContentsAnnotatesSourceReadPermissionDenied(t *testing.T) {
	reporter := newTransferProgressReporter(
		"job-1",
		newTransferProgress(time.Unix(0, 0)),
		func(protocol.Event) {},
		time.Now,
	)

	err := transferFileContents(
		&errorReadCloser{err: os.ErrPermission},
		&bufferWriteCloser{},
		reporter,
		"/private/source.txt",
		"/target/source.txt",
	)
	if err == nil {
		t.Fatal("expected permission error")
	}

	var transferErr *transferError
	if !errors.As(err, &transferErr) {
		t.Fatalf("expected transferError, got %T: %v", err, err)
	}
	if transferErr.Code != transferErrorPermissionDenied {
		t.Fatalf("expected permission denied code, got %q", transferErr.Code)
	}
	if transferErr.Operation != "source_read" {
		t.Fatalf("expected source_read operation, got %q", transferErr.Operation)
	}
	if transferErr.Path != "/private/source.txt" {
		t.Fatalf("expected source path, got %q", transferErr.Path)
	}
}

func TestTransferFileContentsAnnotatesTargetWritePermissionDenied(t *testing.T) {
	reporter := newTransferProgressReporter(
		"job-1",
		newTransferProgress(time.Unix(0, 0)),
		func(protocol.Event) {},
		time.Now,
	)

	err := transferFileContents(
		&simpleReadCloser{Reader: bytes.NewBufferString("payload")},
		&errorWriteCloser{err: os.ErrPermission},
		reporter,
		"/source/payload.txt",
		"/restricted/payload.txt",
	)
	if err == nil {
		t.Fatal("expected permission error")
	}

	var transferErr *transferError
	if !errors.As(err, &transferErr) {
		t.Fatalf("expected transferError, got %T: %v", err, err)
	}
	if transferErr.Code != transferErrorPermissionDenied {
		t.Fatalf("expected permission denied code, got %q", transferErr.Code)
	}
	if transferErr.Operation != "target_write" {
		t.Fatalf("expected target_write operation, got %q", transferErr.Operation)
	}
	if transferErr.Path != "/restricted/payload.txt" {
		t.Fatalf("expected target path, got %q", transferErr.Path)
	}
}

func TestCopyFileWithProgressCancelsBlockedTransfer(t *testing.T) {
	progress := newTransferProgress(time.Unix(0, 0))
	progress.bytesTotal = 1024
	reporter := newTransferProgressReporter(
		"job-1",
		progress,
		func(protocol.Event) {},
		time.Now,
	)
	source := &blockingReadCloser{
		reader: bytes.NewBuffer(make([]byte, 1024)),
	}
	target := newBlockingWriteCloser()
	sourceFS := fakeFilesystemAccessor{
		openFile: source,
	}
	targetFS := fakeFilesystemAccessor{
		createFile: target,
	}
	ctx, cancel := context.WithCancel(context.Background())
	resultCh := make(chan error, 1)

	go func() {
		resultCh <- copyFileWithProgress(
			ctx,
			sourceFS,
			targetFS,
			"/source.bin",
			"/target.bin",
			reporter,
		)
	}()

	time.Sleep(50 * time.Millisecond)
	cancel()

	select {
	case err := <-resultCh:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("expected context cancellation, got %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for cancelled transfer to return")
	}

	if !target.closed {
		t.Fatal("expected target file handle to be closed on cancellation")
	}
	if !source.closed {
		t.Fatal("expected source file handle to be closed on cancellation")
	}
}

func TestCopyFileWithProgressAnnotatesRemoteTargetPermissionDenied(t *testing.T) {
	reporter := newTransferProgressReporter(
		"job-1",
		newTransferProgress(time.Unix(0, 0)),
		func(protocol.Event) {},
		time.Now,
	)
	sourceFS := fakeFilesystemAccessor{
		openFile: &simpleReadCloser{Reader: bytes.NewBufferString("payload")},
	}
	targetFS := fakeFilesystemAccessor{
		createErr: &sftppkg.StatusError{Code: 3},
	}

	err := copyFileWithProgress(
		context.Background(),
		sourceFS,
		targetFS,
		"/source/payload.txt",
		"/restricted/payload.txt",
		reporter,
	)
	if err == nil {
		t.Fatal("expected permission error")
	}

	var transferErr *transferError
	if !errors.As(err, &transferErr) {
		t.Fatalf("expected transferError, got %T: %v", err, err)
	}
	if transferErr.Code != transferErrorPermissionDenied {
		t.Fatalf("expected permission denied code, got %q", transferErr.Code)
	}
	if transferErr.Operation != "target_create" {
		t.Fatalf("expected target_create operation, got %q", transferErr.Operation)
	}
	if transferErr.Path != "/restricted/payload.txt" {
		t.Fatalf("expected target path, got %q", transferErr.Path)
	}
}

func TestCopyFileWithProgressAnnotatesLocalSourcePermissionDenied(t *testing.T) {
	reporter := newTransferProgressReporter(
		"job-1",
		newTransferProgress(time.Unix(0, 0)),
		func(protocol.Event) {},
		time.Now,
	)
	sourceFS := fakeFilesystemAccessor{
		openErr: os.ErrPermission,
	}
	targetFS := fakeFilesystemAccessor{}

	err := copyFileWithProgress(
		context.Background(),
		sourceFS,
		targetFS,
		"/private/source.txt",
		"/target/source.txt",
		reporter,
	)
	if err == nil {
		t.Fatal("expected permission error")
	}

	var transferErr *transferError
	if !errors.As(err, &transferErr) {
		t.Fatalf("expected transferError, got %T: %v", err, err)
	}
	if transferErr.Code != transferErrorPermissionDenied {
		t.Fatalf("expected permission denied code, got %q", transferErr.Code)
	}
	if transferErr.Operation != "source_open" {
		t.Fatalf("expected source_open operation, got %q", transferErr.Operation)
	}
	if transferErr.Path != "/private/source.txt" {
		t.Fatalf("expected source path, got %q", transferErr.Path)
	}
}

func TestPrepareDestinationAnnotatesOverwritePermissionDenied(t *testing.T) {
	targetFS := fakeFilesystemAccessor{
		statInfo:  fakeFileInfo{name: "existing.txt"},
		removeErr: os.ErrPermission,
	}

	_, _, _, err := prepareDestination(
		targetFS,
		fakeFileInfo{name: "source.txt"},
		"/restricted/existing.txt",
		"overwrite",
	)
	if err == nil {
		t.Fatal("expected permission error")
	}

	var transferErr *transferError
	if !errors.As(err, &transferErr) {
		t.Fatalf("expected transferError, got %T: %v", err, err)
	}
	if transferErr.Code != transferErrorPermissionDenied {
		t.Fatalf("expected permission denied code, got %q", transferErr.Code)
	}
	if transferErr.Operation != "target_remove" {
		t.Fatalf("expected target_remove operation, got %q", transferErr.Operation)
	}
	if transferErr.Path != "/restricted/existing.txt" {
		t.Fatalf("expected overwrite target path, got %q", transferErr.Path)
	}
}

type simpleReadCloser struct {
	io.Reader
}

func (reader *simpleReadCloser) Close() error {
	return nil
}

type fakeConcurrentTarget struct {
	buffer         bytes.Buffer
	readFromCalled bool
	concurrency    int
}

func (target *fakeConcurrentTarget) Write(buffer []byte) (int, error) {
	return target.buffer.Write(buffer)
}

func (target *fakeConcurrentTarget) Close() error {
	return nil
}

func (target *fakeConcurrentTarget) ReadFromWithConcurrency(
	reader io.Reader,
	concurrency int,
) (int64, error) {
	target.readFromCalled = true
	target.concurrency = concurrency
	return target.buffer.ReadFrom(reader)
}

type writerToReadCloser struct {
	content       []byte
	writeToCalled bool
}

func (reader *writerToReadCloser) Read(_ []byte) (int, error) {
	return 0, io.EOF
}

func (reader *writerToReadCloser) Close() error {
	return nil
}

func (reader *writerToReadCloser) WriteTo(writer io.Writer) (int64, error) {
	reader.writeToCalled = true
	written, err := writer.Write(reader.content)
	return int64(written), err
}

type bufferWriteCloser struct {
	buffer bytes.Buffer
}

func (writer *bufferWriteCloser) Write(buffer []byte) (int, error) {
	return writer.buffer.Write(buffer)
}

func (writer *bufferWriteCloser) Close() error {
	return nil
}

type errorReadCloser struct {
	err error
}

func (reader *errorReadCloser) Read([]byte) (int, error) {
	return 0, reader.err
}

func (reader *errorReadCloser) Close() error {
	return nil
}

type errorWriteCloser struct {
	err error
}

func (writer *errorWriteCloser) Write([]byte) (int, error) {
	return 0, writer.err
}

func (writer *errorWriteCloser) Close() error {
	return nil
}

type blockingReadCloser struct {
	reader *bytes.Buffer
	closed bool
}

func (reader *blockingReadCloser) Read(buffer []byte) (int, error) {
	return reader.reader.Read(buffer)
}

func (reader *blockingReadCloser) Close() error {
	reader.closed = true
	return nil
}

type blockingWriteCloser struct {
	closeCh chan struct{}
	closed  bool
}

func newBlockingWriteCloser() *blockingWriteCloser {
	return &blockingWriteCloser{
		closeCh: make(chan struct{}),
	}
}

func (writer *blockingWriteCloser) Write(_ []byte) (int, error) {
	<-writer.closeCh
	return 0, os.ErrClosed
}

func (writer *blockingWriteCloser) Close() error {
	if !writer.closed {
		writer.closed = true
		close(writer.closeCh)
	}
	return nil
}

type fakeFilesystemAccessor struct {
	openFile   io.ReadCloser
	openErr    error
	createFile io.WriteCloser
	createErr  error
	statInfo   os.FileInfo
	statErr    error
	readDirErr error
	mkdirErr   error
	removeErr  error
}

func (accessor fakeFilesystemAccessor) Join(base string, elem ...string) string {
	return base
}

func (accessor fakeFilesystemAccessor) Dir(targetPath string) string {
	return targetPath
}

func (accessor fakeFilesystemAccessor) Base(targetPath string) string {
	return targetPath
}

func (accessor fakeFilesystemAccessor) Stat(string) (os.FileInfo, error) {
	if accessor.statErr != nil {
		return nil, accessor.statErr
	}
	if accessor.statInfo != nil {
		return accessor.statInfo, nil
	}
	return nil, os.ErrNotExist
}

func (accessor fakeFilesystemAccessor) ReadDir(string) ([]os.FileInfo, error) {
	if accessor.readDirErr != nil {
		return nil, accessor.readDirErr
	}
	return nil, nil
}

func (accessor fakeFilesystemAccessor) Open(string) (io.ReadCloser, error) {
	if accessor.openErr != nil {
		return nil, accessor.openErr
	}
	return accessor.openFile, nil
}

func (accessor fakeFilesystemAccessor) Create(string) (io.WriteCloser, error) {
	if accessor.createErr != nil {
		return nil, accessor.createErr
	}
	return accessor.createFile, nil
}

func (accessor fakeFilesystemAccessor) MkdirAll(string) error {
	return accessor.mkdirErr
}

func (accessor fakeFilesystemAccessor) Remove(string) error {
	return accessor.removeErr
}

func (accessor fakeFilesystemAccessor) RemoveDirectory(string) error {
	return accessor.removeErr
}

type fakeFileInfo struct {
	name  string
	size  int64
	isDir bool
}

func (info fakeFileInfo) Name() string {
	return info.name
}

func (info fakeFileInfo) Size() int64 {
	return info.size
}

func (info fakeFileInfo) Mode() os.FileMode {
	if info.isDir {
		return os.ModeDir | 0o755
	}
	return 0o644
}

func (info fakeFileInfo) ModTime() time.Time {
	return time.Unix(0, 0)
}

func (info fakeFileInfo) IsDir() bool {
	return info.isDir
}

func (info fakeFileInfo) Sys() any {
	return nil
}
