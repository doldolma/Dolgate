//go:build windows

package awssession

import (
	"path/filepath"
	"testing"
)

func TestRuntimeToolCandidatesPreferOfficialExecutablesAndSkipWrappers(t *testing.T) {
	t.Setenv("PATH", `C:\custom\bin;C:\other\tools`)

	candidates := runtimeToolCandidates("aws")
	if len(candidates) < 3 {
		t.Fatalf("expected at least 3 candidates, got %d", len(candidates))
	}

	if candidates[0] != `C:\Program Files\Amazon\AWSCLIV2\aws.exe` {
		t.Fatalf("first candidate = %q", candidates[0])
	}

	expectedPathCandidate := filepath.Join(`C:\custom\bin`, "aws.exe")
	if candidates[1] != expectedPathCandidate {
		t.Fatalf("second candidate = %q", candidates[1])
	}
}
