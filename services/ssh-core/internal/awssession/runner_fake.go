package awssession

import (
	"io"
	"sync"
)

type fakeRunner struct {
	outputReader *io.PipeReader
	outputWriter *io.PipeWriter
	done         chan sessionExit
	doneOnce     sync.Once
}

func newFakeRunner(initialOutput string) sessionRunner {
	outputReader, outputWriter := io.Pipe()
	runner := &fakeRunner{
		outputReader: outputReader,
		outputWriter: outputWriter,
		done:         make(chan sessionExit, 1),
	}

	if initialOutput != "" {
		go func() {
			_, _ = outputWriter.Write([]byte(initialOutput))
		}()
	}

	return runner
}

func (r *fakeRunner) Write(data []byte) error {
	if len(data) == 0 {
		return nil
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
	return []io.Reader{r.outputReader}
}

func (r *fakeRunner) Wait() (sessionExit, error) {
	exit, ok := <-r.done
	if !ok {
		return sessionExit{ExitCode: 0}, nil
	}
	return exit, nil
}
