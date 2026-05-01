package containers

import (
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"

	"dolssh/services/ssh-core/internal/protocol"
)

func TestParseRuntimeProbeOutputReturnsAbsoluteDockerPath(t *testing.T) {
	runtime, runtimeCommand, unsupportedReason, err := parseRuntimeProbeOutput(
		"docker\t/var/packages/ContainerManager/target/usr/bin/docker",
	)
	if err != nil {
		t.Fatalf("parseRuntimeProbeOutput returned error: %v", err)
	}
	if runtime != "docker" {
		t.Fatalf("expected docker runtime, got %q", runtime)
	}
	if runtimeCommand != "/var/packages/ContainerManager/target/usr/bin/docker" {
		t.Fatalf("expected absolute runtime command, got %q", runtimeCommand)
	}
	if unsupportedReason != "" {
		t.Fatalf("expected empty unsupported reason, got %q", unsupportedReason)
	}
}

func TestBuildUnsupportedRuntimeReasonIncludesTriedPaths(t *testing.T) {
	reason := buildUnsupportedRuntimeReason("/bin/zsh", "shell fallback did not return docker/podman")
	expectedSnippets := []string{
		"/var/packages/ContainerManager/target/usr/bin/docker",
		"/var/packages/Docker/target/usr/bin/docker",
		"/usr/bin/podman",
		"/bin/zsh",
		"shell fallback did not return docker/podman",
	}
	for _, snippet := range expectedSnippets {
		if !strings.Contains(reason, snippet) {
			t.Fatalf("expected unsupported reason to include %q, got %q", snippet, reason)
		}
	}
}

func TestDockerRuntimeCandidatesPreferSynologyPaths(t *testing.T) {
	if len(dockerRuntimeCandidatePaths) < 2 {
		t.Fatalf("expected docker runtime candidates to include Synology paths")
	}
	if dockerRuntimeCandidatePaths[0] != "/var/packages/ContainerManager/target/usr/bin/docker" {
		t.Fatalf("expected first docker runtime candidate to be Container Manager path, got %q", dockerRuntimeCandidatePaths[0])
	}
	if dockerRuntimeCandidatePaths[1] != "/var/packages/Docker/target/usr/bin/docker" {
		t.Fatalf("expected second docker runtime candidate to be legacy Synology Docker path, got %q", dockerRuntimeCandidatePaths[1])
	}
}

func TestExtractShellRuntimeProbePayloadIgnoresPromptNoise(t *testing.T) {
	output := "Last login: today\n__DOLGATE_RUNTIME_PROBE_START__\ndocker\t/usr/local/bin/docker\n__DOLGATE_RUNTIME_PROBE_END__\n%"
	payload := extractShellRuntimeProbePayload(output)
	if payload != "docker\t/usr/local/bin/docker" {
		t.Fatalf("expected extracted payload to ignore shell noise, got %q", payload)
	}
}

func TestBuildLogsCommandIncludesSinceCursorWhenPresent(t *testing.T) {
	command := buildLogsCommand(
		"/usr/local/bin/docker",
		"container-1",
		200,
		"2026-03-28T09:00:54.613802395Z",
		"",
		"",
	)

	expectedSnippets := []string{
		"'/usr/local/bin/docker' logs --timestamps --tail 200",
		"--since '2026-03-28T09:00:54.613802395Z'",
		"'container-1'",
	}
	for _, snippet := range expectedSnippets {
		if !strings.Contains(command, snippet) {
			t.Fatalf("expected logs command to include %q, got %q", snippet, command)
		}
	}
}

func TestBuildLogsCommandIncludesAbsoluteRangeWhenPresent(t *testing.T) {
	command := buildLogsCommand(
		"/usr/local/bin/docker",
		"container-1",
		200,
		"",
		"2026-03-28T09:00:00Z",
		"2026-03-28T09:30:00Z",
	)

	expectedSnippets := []string{
		"'/usr/local/bin/docker' logs --timestamps --tail 200",
		"--since '2026-03-28T09:00:00Z'",
		"--until '2026-03-28T09:30:00Z'",
		"'container-1'",
	}
	for _, snippet := range expectedSnippets {
		if !strings.Contains(command, snippet) {
			t.Fatalf("expected logs command to include %q, got %q", snippet, command)
		}
	}
}

func TestBuildLogsCommandFollowCursorTakesPrecedenceOverAbsoluteRange(t *testing.T) {
	command := buildLogsCommand(
		"/usr/local/bin/docker",
		"container-1",
		200,
		"2026-03-28T09:15:00Z",
		"2026-03-28T09:00:00Z",
		"2026-03-28T09:30:00Z",
	)

	if !strings.Contains(command, "--since '2026-03-28T09:15:00Z'") {
		t.Fatalf("expected follow cursor to be used as since, got %q", command)
	}
	if strings.Contains(command, "--until") {
		t.Fatalf("expected follow command to omit absolute until, got %q", command)
	}
}

func TestSplitOutputLinesReturnsEmptySliceForBlankOutput(t *testing.T) {
	lines := splitOutputLines("\n \n\t")
	if lines == nil {
		t.Fatalf("expected empty slice, got nil")
	}
	if len(lines) != 0 {
		t.Fatalf("expected 0 lines, got %d", len(lines))
	}
}

func TestBuildContainerActionCommandUsesExpectedDockerVerb(t *testing.T) {
	tests := map[string]string{
		"start":   "'/usr/bin/docker' start 'container-1'",
		"stop":    "'/usr/bin/docker' stop 'container-1'",
		"restart": "'/usr/bin/docker' restart 'container-1'",
		"remove":  "'/usr/bin/docker' rm 'container-1'",
	}

	for action, expected := range tests {
		if command := buildContainerActionCommand("/usr/bin/docker", action, "container-1"); command != expected {
			t.Fatalf("expected %q for action %q, got %q", expected, action, command)
		}
	}
}

func TestBuildExitStatusWrappedCommandEmitsActionStatusMarker(t *testing.T) {
	command := buildExitStatusWrappedCommand("'/usr/bin/docker' restart 'container-1'")

	expectedSnippets := []string{
		"sh -lc ",
		"/usr/bin/docker",
		"restart",
		"container-1",
		containerActionExitMarker,
		"exit 0",
	}
	for _, snippet := range expectedSnippets {
		if !strings.Contains(command, snippet) {
			t.Fatalf("expected wrapped command to include %q, got %q", snippet, command)
		}
	}
}

func TestParseExitStatusWrappedOutputReturnsCommandBodyAndExitCode(t *testing.T) {
	body, exitCode, ok := parseExitStatusWrappedOutput(
		"container-1\n" + containerActionExitMarker + "0\n",
	)

	if !ok {
		t.Fatalf("expected wrapped output to include an exit code")
	}
	if exitCode != 0 {
		t.Fatalf("expected exit code 0, got %d", exitCode)
	}
	if body != "container-1" {
		t.Fatalf("expected body to be trimmed command output, got %q", body)
	}
}

func TestParseExitStatusWrappedOutputReturnsFailureCode(t *testing.T) {
	body, exitCode, ok := parseExitStatusWrappedOutput(
		"permission denied\n" + containerActionExitMarker + "126\n",
	)

	if !ok {
		t.Fatalf("expected wrapped output to include an exit code")
	}
	if exitCode != 126 {
		t.Fatalf("expected exit code 126, got %d", exitCode)
	}
	if body != "permission denied" {
		t.Fatalf("expected failure body to be preserved, got %q", body)
	}
}

func TestBuildStatsCommandIncludesNoStreamAndFormat(t *testing.T) {
	command := buildStatsCommand("/usr/bin/docker", "container-1")
	expectedSnippets := []string{
		"'/usr/bin/docker' stats --no-stream",
		"{{.CPUPerc}}",
		"{{.MemUsage}}",
		"'container-1'",
	}
	for _, snippet := range expectedSnippets {
		if !strings.Contains(command, snippet) {
			t.Fatalf("expected stats command to include %q, got %q", snippet, command)
		}
	}
}

func TestBuildSearchLogsCommandUsesCaseInsensitiveFixedStringGrep(t *testing.T) {
	command := buildSearchLogsCommand(
		"/usr/bin/docker",
		"container-1",
		1200,
		"error text",
		"2026-03-28T09:00:00Z",
		"2026-03-28T09:30:00Z",
	)
	expectedSnippets := []string{
		"logs --timestamps --tail 1200",
		"--since '2026-03-28T09:00:00Z'",
		"--until '2026-03-28T09:30:00Z'",
		"LC_ALL=C grep -iF -- 'error text'",
		"'container-1'",
	}
	for _, snippet := range expectedSnippets {
		if !strings.Contains(command, snippet) {
			t.Fatalf("expected search command to include %q, got %q", snippet, command)
		}
	}
}

func TestParsePercentAndUsageHelpers(t *testing.T) {
	if got := parsePercent("12.5%"); got != 12.5 {
		t.Fatalf("expected 12.5, got %v", got)
	}
	left, right, err := parseUsagePair("12.3MiB / 256MiB")
	if err != nil {
		t.Fatalf("expected usage pair to parse, got %v", err)
	}
	if left != 12897484 {
		t.Fatalf("expected left bytes 12897484, got %d", left)
	}
	if right != 268435456 {
		t.Fatalf("expected right bytes 268435456, got %d", right)
	}
	bytes, err := parseByteSize("1.5GB")
	if err != nil {
		t.Fatalf("expected byte size to parse, got %v", err)
	}
	if bytes != 1500000000 {
		t.Fatalf("expected 1500000000 bytes, got %d", bytes)
	}
}

func TestParseContainerPortSpecSupportsTCPAndUDP(t *testing.T) {
	containerPort, protocolName, ok := parseContainerPortSpec("8080/tcp")
	if !ok {
		t.Fatalf("expected tcp port spec to parse")
	}
	if containerPort != 8080 || protocolName != "tcp" {
		t.Fatalf("expected 8080/tcp, got %d/%s", containerPort, protocolName)
	}

	containerPort, protocolName, ok = parseContainerPortSpec("5353/udp")
	if !ok {
		t.Fatalf("expected udp port spec to parse")
	}
	if containerPort != 5353 || protocolName != "udp" {
		t.Fatalf("expected 5353/udp, got %d/%s", containerPort, protocolName)
	}

	if _, _, ok = parseContainerPortSpec("invalid"); ok {
		t.Fatalf("expected invalid port spec to fail")
	}
}

func TestTakeClientRemovesEndpointAndReturnsOwnedClient(t *testing.T) {
	service := New(func(protocol.Event) {})
	service.endpoints["containers:host-1:forward:rule-1"] = &endpointHandle{
		client:         &ssh.Client{},
		runtime:        "docker",
		runtimeCommand: "/usr/bin/docker",
	}

	client, err := service.TakeClient("containers:host-1:forward:rule-1")
	if err != nil {
		t.Fatalf("TakeClient() error = %v", err)
	}
	if client == nil {
		t.Fatal("TakeClient() returned nil client")
	}
	if _, exists := service.endpoints["containers:host-1:forward:rule-1"]; exists {
		t.Fatal("endpoint still present after TakeClient()")
	}
}
