package hostsoverrideipc

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/hostsoverride"
)

func TestSocketFileMode(t *testing.T) {
	t.Parallel()

	if got := socketFileMode("darwin"); got != 0o666 {
		t.Fatalf("socketFileMode(darwin) = %o, want %o", got, 0o666)
	}
	if got := socketFileMode("linux"); got != 0o600 {
		t.Fatalf("socketFileMode(linux) = %o, want %o", got, 0o600)
	}
}

func TestServeHandlesPingRewriteClearAndShutdown(t *testing.T) {
	t.Parallel()

	tempDir := t.TempDir()
	hostsFilePath := filepath.Join(tempDir, "hosts")
	if err := os.WriteFile(hostsFilePath, []byte("127.0.0.1 localhost\n# custom\n"), 0o644); err != nil {
		t.Fatalf("write hosts fixture: %v", err)
	}

	endpoint := buildTestEndpoint(tempDir)
	listener, err := Listen(endpoint)
	if err != nil {
		t.Fatalf("Listen() error = %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	serverErr := make(chan error, 1)
	go func() {
		serverErr <- Serve(ctx, cancel, listener, ServeConfig{
			AuthToken:     "secret",
			HostsFilePath: hostsFilePath,
		})
	}()

	waitForEndpoint(t, endpoint)

	if runtime.GOOS != "windows" {
		info, err := os.Stat(endpoint)
		if err != nil {
			t.Fatalf("Stat(endpoint) error = %v", err)
		}
		gotMode := info.Mode().Perm()
		wantMode := socketFileMode(runtime.GOOS)
		if gotMode != wantMode {
			t.Fatalf("endpoint mode = %o, want %o", gotMode, wantMode)
		}
	}

	response, err := SendRequest(context.Background(), endpoint, Request{
		Command:   CommandPing,
		AuthToken: "secret",
	})
	if err != nil {
		t.Fatalf("SendRequest(ping) error = %v", err)
	}
	if !response.OK {
		t.Fatalf("expected ping OK, got %#v", response)
	}

	response, err = SendRequest(context.Background(), endpoint, Request{
		Command:   CommandPing,
		AuthToken: "wrong",
	})
	if err != nil {
		t.Fatalf("SendRequest(unauthorized ping) error = %v", err)
	}
	if response.OK || response.Error == "" {
		t.Fatalf("expected unauthorized error, got %#v", response)
	}

	response, err = SendRequest(context.Background(), endpoint, Request{
		Command:   CommandRewriteBlock,
		AuthToken: "secret",
		Entries: []hostsoverride.Entry{
			{Address: "127.0.0.2", Hostname: "basket"},
			{Address: "10.0.1.15", Hostname: "b-1.kafka.internal"},
		},
	})
	if err != nil {
		t.Fatalf("SendRequest(rewrite-block) error = %v", err)
	}
	if !response.OK {
		t.Fatalf("expected rewrite OK, got %#v", response)
	}

	response, err = SendRequest(context.Background(), endpoint, Request{
		Command:   CommandReadHosts,
		AuthToken: "secret",
	})
	if err != nil {
		t.Fatalf("SendRequest(read-hosts) error = %v", err)
	}
	if !response.OK {
		t.Fatalf("expected read-hosts OK, got %#v", response)
	}

	content, err := os.ReadFile(hostsFilePath)
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	expected := "127.0.0.1 localhost\n# custom\n# >>> dolssh managed dns overrides >>>\n10.0.1.15 b-1.kafka.internal\n127.0.0.2 basket\n# <<< dolssh managed dns overrides <<<\n"
	if string(content) != expected {
		t.Fatalf("unexpected rewritten hosts file:\n%s", string(content))
	}
	if response.HostsFileContent != expected {
		t.Fatalf("unexpected hosts content from helper:\n%s", response.HostsFileContent)
	}

	response, err = SendRequest(context.Background(), endpoint, Request{
		Command:   CommandClearBlock,
		AuthToken: "secret",
	})
	if err != nil {
		t.Fatalf("SendRequest(clear-block) error = %v", err)
	}
	if !response.OK {
		t.Fatalf("expected clear OK, got %#v", response)
	}

	content, err = os.ReadFile(hostsFilePath)
	if err != nil {
		t.Fatalf("ReadFile() after clear error = %v", err)
	}
	if string(content) != "127.0.0.1 localhost\n# custom\n" {
		t.Fatalf("unexpected cleared hosts file:\n%s", string(content))
	}

	response, err = SendRequest(context.Background(), endpoint, Request{
		Command:   CommandShutdown,
		AuthToken: "secret",
	})
	if err != nil {
		t.Fatalf("SendRequest(shutdown) error = %v", err)
	}
	if !response.OK {
		t.Fatalf("expected shutdown OK, got %#v", response)
	}

	select {
	case err := <-serverErr:
		if err != nil {
			t.Fatalf("Serve() error = %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Serve() did not shut down after shutdown request")
	}
}

func waitForEndpoint(t *testing.T, endpoint string) {
	t.Helper()

	if runtime.GOOS == "windows" {
		return
	}

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(endpoint); err == nil {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("endpoint did not appear: %s", endpoint)
}

func buildTestEndpoint(tempDir string) string {
	if runtime.GOOS == "windows" {
		return fmt.Sprintf(`\\.\pipe\dolgate-dns-helper-test-%d`, time.Now().UnixNano())
	}
	return filepath.Join(os.TempDir(), fmt.Sprintf("dgdns-test-%d.sock", time.Now().UnixNano()))
}
