package sftp

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"testing"
	"time"

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

	if err := transferFileContents(source, target, reporter); err != nil {
		t.Fatalf("transferFileContents returned error: %v", err)
	}

	if !source.writeToCalled {
		t.Fatalf("expected writer-to download path to be used")
	}
	if target.buffer.String() != "download me" {
		t.Fatalf("unexpected transferred content: %q", target.buffer.String())
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
	createFile io.WriteCloser
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
	return nil, os.ErrNotExist
}

func (accessor fakeFilesystemAccessor) ReadDir(string) ([]os.FileInfo, error) {
	return nil, nil
}

func (accessor fakeFilesystemAccessor) Open(string) (io.ReadCloser, error) {
	return accessor.openFile, nil
}

func (accessor fakeFilesystemAccessor) Create(string) (io.WriteCloser, error) {
	return accessor.createFile, nil
}

func (accessor fakeFilesystemAccessor) MkdirAll(string) error {
	return nil
}

func (accessor fakeFilesystemAccessor) Remove(string) error {
	return nil
}

func (accessor fakeFilesystemAccessor) RemoveDirectory(string) error {
	return nil
}
