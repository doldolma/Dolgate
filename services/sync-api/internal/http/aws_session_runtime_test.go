package http

import "testing"

// AWS features run in-process (ssh-core data channel + AWS SDK), so the
// runtime no longer probes for aws-cli/session-manager-plugin binaries and is
// unconditionally available.
func TestDetectAwsSsmRuntimeIsAlwaysEnabled(t *testing.T) {
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
