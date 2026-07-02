// ssm-datachannel-spike is a development harness for the in-process SSM data channel
// (internal/ssmdatachannel). It consumes a session token issued elsewhere — in the target
// architecture the Electron main process calls ssm:StartSession / ecs:ExecuteCommand via
// the AWS SDK — and opens the WebSocket data channel directly, with no aws CLI and no
// session-manager-plugin.
//
// Issue a token and run the probe (see apps/desktop/scripts/dev-ssm-start-session.mjs):
//
//	node apps/desktop/scripts/dev-ssm-start-session.mjs --profile p --region r --target i-… \
//	  | go run ./cmd/ssm-datachannel-spike -stdin-json
//
// The probe types an echo command into the remote shell and exits 0 once the marker comes
// back (go), non-zero otherwise (no-go). Use -interactive for a rough manual shell instead
// (line-buffered; no raw terminal mode — type `exit` to end).
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"dolssh/services/ssh-core/internal/ssmdatachannel"
)

type sessionTokenInput struct {
	SessionID  string `json:"sessionId"`
	StreamURL  string `json:"streamUrl"`
	TokenValue string `json:"tokenValue"`
}

func main() {
	url := flag.String("url", "", "SSM data channel stream URL (wss://…)")
	token := flag.String("token", "", "SSM session token value")
	stdinJSON := flag.Bool("stdin-json", false, "read {streamUrl, tokenValue} JSON from stdin")
	interactive := flag.Bool("interactive", false, "pump stdin/stdout as a rough shell instead of running the probe")
	timeout := flag.Duration("timeout", 20*time.Second, "probe timeout")
	flag.Parse()

	if err := run(*url, *token, *stdinJSON, *interactive, *timeout); err != nil {
		fmt.Fprintf(os.Stderr, "\nFAIL: %v\n", err)
		os.Exit(1)
	}
}

func run(url, token string, stdinJSON, interactive bool, timeout time.Duration) error {
	if stdinJSON {
		var input sessionTokenInput
		if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil {
			return fmt.Errorf("decoding session token JSON from stdin: %w", err)
		}
		url, token = input.StreamURL, input.TokenValue
		if input.SessionID != "" {
			fmt.Fprintf(os.Stderr, "session: %s\n", input.SessionID)
		}
	}
	if url == "" || token == "" {
		return errors.New("missing stream URL or token (use -url/-token or -stdin-json)")
	}

	dc := new(ssmdatachannel.SsmDataChannel)
	if err := dc.OpenWithSessionToken(url, token); err != nil {
		return fmt.Errorf("opening data channel: %w", err)
	}
	defer dc.Close()
	fmt.Fprintln(os.Stderr, "data channel open")

	if err := dc.SetTerminalSize(45, 132); err != nil {
		return fmt.Errorf("setting terminal size: %w", err)
	}

	if interactive {
		defer func() { _ = dc.TerminateSession() }()
		go func() { _, _ = dc.ReadFrom(os.Stdin) }()
		if _, err := dc.WriteTo(os.Stdout); err != nil && !errors.Is(err, io.EOF) {
			return err
		}
		return nil
	}

	err := runProbe(dc, timeout)
	_ = dc.TerminateSession()
	return err
}

func runProbe(dc *ssmdatachannel.SsmDataChannel, timeout time.Duration) error {
	const marker = "DOLGATE_SPIKE_OK"
	// The quotes keep the marker out of the terminal's echo of the typed command,
	// so a match can only come from the command's output.
	const probeCommand = "echo DOLGATE_\"SPIKE\"_OK\n"

	payloads := make(chan []byte, 64)
	readErrs := make(chan error, 1)
	go func() {
		buf := make([]byte, 8192)
		for {
			n, err := dc.Read(buf)
			if err != nil {
				readErrs <- err
				return
			}
			payload, err := dc.HandleMsg(buf[:n])
			if err != nil {
				readErrs <- err
				return
			}
			if len(payload) > 0 {
				payloads <- append([]byte(nil), payload...)
			}
		}
	}()

	if _, err := dc.Write([]byte(probeCommand)); err != nil {
		return fmt.Errorf("writing probe command: %w", err)
	}

	var seen bytes.Buffer
	deadline := time.After(timeout)
	for {
		select {
		case p := <-payloads:
			seen.Write(p)
			_, _ = os.Stderr.Write(p)
			if strings.Contains(seen.String(), marker) {
				fmt.Fprintln(os.Stderr, "\nPASS: probe marker received over in-process data channel")
				return nil
			}
		case err := <-readErrs:
			if errors.Is(err, io.EOF) {
				return errors.New("channel closed before probe marker was received")
			}
			return fmt.Errorf("read loop: %w", err)
		case <-deadline:
			return fmt.Errorf("timed out after %s waiting for probe marker (received %d bytes)", timeout, seen.Len())
		}
	}
}
