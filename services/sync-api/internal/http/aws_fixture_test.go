package http

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

// buildFakeAwsCLI compiles the cross-platform fake AWS CLI fixture
// (testfixture/fakeaws) into dir under baseName, appending .exe on Windows so
// exec.LookPath (which honours PATHEXT) can resolve it from PATH. It replaces
// the POSIX shell-script fixtures that could not execute on Windows. Runtime
// behaviour is selected by the caller via the FAKE_AWS_MODE environment
// variable; see the fixture's package comment for the supported modes.
func buildFakeAwsCLI(t *testing.T, dir, baseName string) string {
	t.Helper()

	if runtime.GOOS == "windows" {
		baseName += ".exe"
	}
	binaryPath := filepath.Join(dir, baseName)

	buildCommand := exec.Command("go", "build", "-o", binaryPath, "./testfixture/fakeaws")
	buildCommand.Dir = "."
	buildCommand.Env = append(os.Environ(), "CGO_ENABLED=0")
	if output, err := buildCommand.CombinedOutput(); err != nil {
		t.Fatalf("build fake aws cli (%s): %v\n%s", baseName, err, output)
	}
	return binaryPath
}
