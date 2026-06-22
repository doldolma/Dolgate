package http

import (
	"testing"
	"time"
)

func TestDetectAwsSsmRuntimeSupportsMobileSsoBrowserFlow(t *testing.T) {
	dir := t.TempDir()
	buildFakeAwsCLI(t, dir, "aws")
	buildFakeAwsCLI(t, dir, "session-manager-plugin")
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
	if runtime.AwsSsoBrowserFlowRecoverable {
		t.Fatalf("DetectAwsSsmRuntime().AwsSsoBrowserFlowRecoverable = true, want false")
	}
}

func TestDetectAwsSsmRuntimeRejectsOldAwsCliForMobileSsoBrowserFlow(t *testing.T) {
	dir := t.TempDir()
	buildFakeAwsCLI(t, dir, "aws")
	buildFakeAwsCLI(t, dir, "session-manager-plugin")
	t.Setenv("FAKE_AWS_MODE", "old-cli")
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
	if runtime.AwsSsoBrowserFlowRecoverable {
		t.Fatalf("DetectAwsSsmRuntime().AwsSsoBrowserFlowRecoverable = true, want false")
	}
}

func TestDetectAwsSsmRuntimeMarksMobileSsoBrowserFlowTimeoutRecoverable(t *testing.T) {
	dir := t.TempDir()
	awsPath := buildFakeAwsCLI(t, dir, "aws")
	t.Setenv("FAKE_AWS_MODE", "timeout")

	supported, reason, recoverable := detectAwsSsoBrowserFlowSupportWithTimeout(awsPath, 10*time.Millisecond)
	if supported {
		t.Fatalf("detectAwsSsoBrowserFlowSupportWithTimeout() supported = true, want false")
	}
	if reason != "AWS CLI mobile SSO probe timed out" {
		t.Fatalf("detectAwsSsoBrowserFlowSupportWithTimeout() reason = %q, want timeout", reason)
	}
	if !recoverable {
		t.Fatalf("detectAwsSsoBrowserFlowSupportWithTimeout() recoverable = false, want true")
	}
}

func TestDetectAwsSsmRuntimeWithoutAws(t *testing.T) {
	dir := t.TempDir()
	buildFakeAwsCLI(t, dir, "session-manager-plugin")
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
	if runtime.AwsSsoBrowserFlowRecoverable {
		t.Fatalf("DetectAwsSsmRuntime().AwsSsoBrowserFlowRecoverable = true, want false")
	}
}
