package hostsoverride

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRewriteManagedHostsFileAndClearManagedHostsFile(t *testing.T) {
	t.Parallel()

	hostsFilePath := filepath.Join(t.TempDir(), "hosts")
	if err := os.WriteFile(hostsFilePath, []byte("127.0.0.1 localhost\n# custom\n"), 0o644); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	if err := RewriteManagedHostsFile(hostsFilePath, []Entry{
		{Address: "127.0.0.2", Hostname: "basket"},
		{Address: "10.0.1.15", Hostname: "b-1.kafka.internal"},
	}); err != nil {
		t.Fatalf("RewriteManagedHostsFile() error = %v", err)
	}

	content, err := os.ReadFile(hostsFilePath)
	if err != nil {
		t.Fatalf("ReadFile() after rewrite error = %v", err)
	}

	expectedAfterRewrite := "127.0.0.1 localhost\n# custom\n# >>> dolssh managed dns overrides >>>\n10.0.1.15 b-1.kafka.internal\n127.0.0.2 basket\n# <<< dolssh managed dns overrides <<<\n"
	if string(content) != expectedAfterRewrite {
		t.Fatalf("unexpected rewritten file:\n%s", string(content))
	}

	if err := ClearManagedHostsFile(hostsFilePath); err != nil {
		t.Fatalf("ClearManagedHostsFile() error = %v", err)
	}

	content, err = os.ReadFile(hostsFilePath)
	if err != nil {
		t.Fatalf("ReadFile() after clear error = %v", err)
	}

	if string(content) != "127.0.0.1 localhost\n# custom\n" {
		t.Fatalf("unexpected cleared file:\n%s", string(content))
	}
}
