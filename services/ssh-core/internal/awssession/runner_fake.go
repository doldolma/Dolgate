package awssession

import (
	"io"
	"sync"

	"dolssh/services/ssh-core/internal/autocomplete"
)

type fakeRunner struct {
	outputReader *io.PipeReader
	outputWriter *io.PipeWriter
	done         chan sessionExit
	doneOnce     sync.Once
	primeOnce    sync.Once
	mu           sync.Mutex
	initial      string
}

func newFakeRunner(initialOutput string) sessionRunner {
	outputReader, outputWriter := io.Pipe()
	runner := &fakeRunner{
		outputReader: outputReader,
		outputWriter: outputWriter,
		done:         make(chan sessionExit, 1),
		initial:      initialOutput,
	}

	return runner
}

func (r *fakeRunner) Write(data []byte) error {
	if len(data) == 0 {
		return nil
	}
	if string(data) == autocomplete.ShellIntegrationInitCommand() {
		r.mu.Lock()
		initial := r.initial
		r.initial = ""
		r.mu.Unlock()
		payload := append(append([]byte(nil), data...), []byte(autocomplete.PromptStartMarker)...)
		payload = append(payload, []byte(initial)...)
		_, err := r.outputWriter.Write(payload)
		return err
	}
	_, err := r.outputWriter.Write(data)
	return err
}

func (r *fakeRunner) SendControlSignal(signal string) error {
	_, err := normalizeControlSignal(signal)
	return err
}

func (r *fakeRunner) Resize(cols, rows int) error {
	_, _ = normalizedSize(cols, rows)
	return nil
}

func (r *fakeRunner) Kill() error {
	r.doneOnce.Do(func() {
		r.done <- sessionExit{ExitCode: 0}
		close(r.done)
		_ = r.outputWriter.Close()
	})
	return nil
}

func (r *fakeRunner) Close() error {
	_ = r.outputReader.Close()
	_ = r.outputWriter.Close()
	return nil
}

func (r *fakeRunner) Streams() []io.Reader {
	r.primeOnce.Do(func() {
		go func() {
			_, _ = r.outputWriter.Write([]byte("$ "))
		}()
	})
	return []io.Reader{r.outputReader}
}

func (r *fakeRunner) Wait() (sessionExit, error) {
	exit, ok := <-r.done
	if !ok {
		return sessionExit{ExitCode: 0}, nil
	}
	return exit, nil
}
