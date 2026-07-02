package awssession

import (
	"errors"
	"fmt"
	"io"
	"sync"

	"dolssh/services/ssh-core/internal/protocol"
	"dolssh/services/ssh-core/internal/ssmdatachannel"
)

// datachannelRunner drives an AWS SSM session over the in-process data channel
// instead of spawning aws + session-manager-plugin. The remote PTY lives on the
// SSM agent, so there is no local PTY/ConPTY: input, output, resize, and control
// signals are all just protocol messages.
type datachannelRunner struct {
	dc     *ssmdatachannel.SsmDataChannel
	reader *io.PipeReader
	writer *io.PipeWriter

	done chan struct{}

	mu     sync.Mutex
	killed bool
	exit   sessionExit
	waitEr error
}

func startDataChannelRunner(payload protocol.AWSConnectPayload) (sessionRunner, error) {
	dc := new(ssmdatachannel.SsmDataChannel)
	if err := dc.OpenWithSessionToken(payload.StreamURL, payload.TokenValue); err != nil {
		return nil, fmt.Errorf("opening SSM data channel: %w", err)
	}

	cols, rows := normalizedSize(payload.Cols, payload.Rows)
	if err := dc.SetTerminalSize(uint32(rows), uint32(cols)); err != nil {
		_ = dc.Close()
		return nil, fmt.Errorf("setting SSM terminal size: %w", err)
	}

	reader, writer := io.Pipe()
	runner := &datachannelRunner{
		dc:     dc,
		reader: reader,
		writer: writer,
		done:   make(chan struct{}),
	}
	go runner.pump()
	return runner, nil
}

// pump moves decoded output payloads from the data channel into the pipe the
// manager reads via Streams(). It owns the runner's exit state.
func (r *datachannelRunner) pump() {
	defer close(r.done)

	// Read copies one whole websocket message; the agent sends small frames
	// (~1.5KB), so this leaves generous headroom.
	buffer := make([]byte, 32*1024)
	for {
		n, err := r.dc.Read(buffer)
		if err != nil {
			r.finish(err)
			return
		}

		payload, err := r.dc.HandleMsg(buffer[:n])
		if len(payload) > 0 {
			// Blocks until the manager consumes it: natural backpressure.
			if _, writeErr := r.writer.Write(payload); writeErr != nil {
				r.finish(writeErr)
				return
			}
		}
		if err != nil {
			r.finish(err)
			return
		}
	}
}

func (r *datachannelRunner) finish(cause error) {
	r.mu.Lock()
	killed := r.killed
	if errors.Is(cause, io.EOF) || killed {
		// Remote shell exit (ChannelClosed) or client-requested disconnect.
		r.exit = sessionExit{}
		r.waitEr = nil
	} else {
		r.exit = sessionExit{ExitCode: 1}
		r.waitEr = cause
	}
	r.mu.Unlock()

	_ = r.writer.Close()
	_ = r.dc.Close()
}

func (r *datachannelRunner) Write(data []byte) error {
	_, err := r.dc.Write(data)
	return err
}

func (r *datachannelRunner) SendControlSignal(signal string) error {
	normalized, err := normalizeControlSignal(signal)
	if err != nil {
		return err
	}

	// The remote PTY interprets the control byte; there is no local process to
	// signal. 0x03=ETX (Ctrl-C), 0x1a=SUB (Ctrl-Z), 0x1c=FS (Ctrl-\).
	var control byte
	switch normalized {
	case "interrupt":
		control = 0x03
	case "suspend":
		control = 0x1a
	case "quit":
		control = 0x1c
	}
	_, err = r.dc.Write([]byte{control})
	return err
}

func (r *datachannelRunner) Resize(cols, rows int) error {
	return r.dc.SetTerminalSize(uint32(rows), uint32(cols))
}

func (r *datachannelRunner) Kill() error {
	r.mu.Lock()
	r.killed = true
	r.mu.Unlock()

	// Ask the service to end the session, then drop the socket; the pump exits
	// via its read error and reports a clean disconnect because killed is set.
	_ = r.dc.TerminateSession()
	err := r.dc.Close()
	// A pump stalled on pipe backpressure only unblocks when the pipe closes;
	// readers drain what was consumed and then see EOF.
	_ = r.writer.Close()
	return err
}

func (r *datachannelRunner) Close() error {
	err := r.dc.Close()
	_ = r.writer.Close()
	_ = r.reader.Close()
	return err
}

func (r *datachannelRunner) Streams() []io.Reader {
	return []io.Reader{r.reader}
}

func (r *datachannelRunner) Wait() (sessionExit, error) {
	<-r.done
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.exit, r.waitEr
}
