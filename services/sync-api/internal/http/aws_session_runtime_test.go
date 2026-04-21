package http

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDetectAwsSsmRuntimeSupportsMobileSsoBrowserFlow(t *testing.T) {
	dir := t.TempDir()
	writeExecutable(t, filepath.Join(dir, "aws"), `#!/bin/sh
if [ "$1" = "sso-oidc" ] && [ "$2" = "register-client" ]; then
  echo '{}'
  exit 0
fi
echo "unexpected command: $*" >&2
exit 1
`)
	writeExecutable(t, filepath.Join(dir, "session-manager-plugin"), "#!/bin/sh\nexit 0\n")
	t.Setenv("PATH", dir)

	runtime := DetectAwsSsmRuntime()
	if !runtime.Enabled {
		t.Fatalf("DetectAwsSsmRuntime().Enabled = false, want true: %#v", runtime)
	}
	if !runtime.AwsSsoBrowserFlowSupported {
		t.Fatalf("DetectAwsSsmRuntime().AwsSsoBrowserFlowSupported = false, want true: %#v", runtime)
	}
	if runtime.AwsSsoBrowserFlowReason != "" {
		t.Fatalf("DetectAwsSsmRuntime().AwsSsoBrowserFlowReason = %q, want empty", runtime.AwsSsoBrowserFlowReason)
	}
}

func TestDetectAwsSsmRuntimeRejectsOldAwsCliForMobileSsoBrowserFlow(t *testing.T) {
	dir := t.TempDir()
	writeExecutable(t, filepath.Join(dir, "aws"), `#!/bin/sh
echo "Unknown options: --issuer-url, --redirect-uris, --grant-types" >&2
exit 252
`)
	writeExecutable(t, filepath.Join(dir, "session-manager-plugin"), "#!/bin/sh\nexit 0\n")
	t.Setenv("PATH", dir)

	runtime := DetectAwsSsmRuntime()
	if !runtime.Enabled {
		t.Fatalf("DetectAwsSsmRuntime().Enabled = false, want true: %#v", runtime)
	}
	if runtime.AwsSsoBrowserFlowSupported {
		t.Fatalf("DetectAwsSsmRuntime().AwsSsoBrowserFlowSupported = true, want false: %#v", runtime)
	}
	if runtime.AwsSsoBrowserFlowReason == "" {
		t.Fatalf("DetectAwsSsmRuntime().AwsSsoBrowserFlowReason should not be empty")
	}
}

func TestDetectAwsSsmRuntimeWithoutAws(t *testing.T) {
	dir := t.TempDir()
	writeExecutable(t, filepath.Join(dir, "session-manager-plugin"), "#!/bin/sh\nexit 0\n")
	t.Setenv("PATH", dir)

	runtime := DetectAwsSsmRuntime()
	if runtime.Enabled {
		t.Fatalf("DetectAwsSsmRuntime().Enabled = true, want false: %#v", runtime)
	}
	if runtime.AwsSsoBrowserFlowSupported {
		t.Fatalf("DetectAwsSsmRuntime().AwsSsoBrowserFlowSupported = true, want false: %#v", runtime)
	}
	if runtime.AwsSsoBrowserFlowReason == "" {
		t.Fatalf("DetectAwsSsmRuntime().AwsSsoBrowserFlowReason should not be empty")
	}
}

func writeExecutable(t *testing.T, path string, contents string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(contents), 0o755); err != nil {
		t.Fatalf("WriteFile(%s) error = %v", path, err)
	}
}
