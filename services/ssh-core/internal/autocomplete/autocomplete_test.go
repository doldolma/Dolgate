package autocomplete

import (
	"bytes"
	"os/exec"
	"strings"
	"testing"
)

func TestParseSnapshot(t *testing.T) {
	var payload bytes.Buffer
	writeFields(&payload, "S", "zsh")
	writeFields(&payload, "H", ": 1710000000:0;sudo systemctl status nginx")
	writeFields(&payload, "H", "sudo systemctl status nginx")
	writeFields(&payload, "H", "bad\ncommand")
	writeFields(&payload, "E", "git", "/usr/bin/git")
	writeFields(&payload, "E", "git", "/opt/bin/git")

	result := ParseSnapshot(payload.Bytes(), 3)
	if result.Capability.Status != "ready" || result.Capability.Shell != "zsh" {
		t.Fatalf("unexpected capability: %#v", result.Capability)
	}
	if result.Snapshot == nil || len(result.Snapshot.History) != 2 {
		t.Fatalf("unexpected history: %#v", result.Snapshot)
	}
	if len(result.Snapshot.Executables) != 1 || result.Snapshot.Executables[0].Path != "/usr/bin/git" {
		t.Fatalf("unexpected executables: %#v", result.Snapshot.Executables)
	}
}

func TestParseSnapshotFiltersInjectedShellIntegration(t *testing.T) {
	var payload bytes.Buffer
	writeFields(&payload, "S", "zsh")
	// The OSC 133 integration script Dolgate types in (zsh keeps it in history,
	// since the trailing bash `history -d` self-cleanup is a no-op there).
	writeFields(&payload, "H", `: 1710000000:0;__ds_o(){ printf '\033]133;%s\007' "$1"; }; precmd_functions+=(__ds_precmd); history -d $((HISTCMD-1)) >/dev/null 2>&1 || true`)
	// The in-band snapshot probe.
	writeFields(&payload, "H", `( printf '\033]6973;n;snapshot;'; cat ) | base64`)
	// Real commands that must survive.
	writeFields(&payload, "H", ": 1710000000:0;ls -la")
	writeFields(&payload, "H", "git status")

	result := ParseSnapshot(payload.Bytes(), 1)
	if result.Snapshot == nil {
		t.Fatal("nil snapshot")
	}
	got := result.Snapshot.History
	want := []string{"ls -la", "git status"}
	if len(got) != len(want) {
		t.Fatalf("expected %v, got %#v", want, got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("expected %v, got %#v", want, got)
		}
	}
}

func TestCollectorCommandsAreValidShellSyntax(t *testing.T) {
	// Validate POSIX syntax via whatever `sh` is on PATH (git-bash on Windows
	// runners); skip if none is available.
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("sh not available")
	}
	for _, command := range []string{RemoteSnapshotCommand(), InBandProbeCommand("nonce-1")} {
		if output, err := exec.Command(sh, "-n", "-c", command).CombinedOutput(); err != nil {
			t.Fatalf("invalid command: %v\n%s", err, output)
		}
	}
}

func TestUnsupportedShell(t *testing.T) {
	var payload bytes.Buffer
	writeFields(&payload, "S", "fish")
	result := ParseSnapshot(payload.Bytes(), 1)
	if result.Capability.Status != "unsupported" || result.Snapshot != nil {
		t.Fatalf("unexpected result: %#v", result)
	}
}

func TestNormalizeShellIntegrationShell(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want string
	}{
		{in: "bash", want: "bash"},
		{in: "-zsh", want: "zsh"},
		{in: "/usr/bin/fish", want: "fish"},
		{in: `C:\Program Files\PowerShell\7\pwsh.exe`, want: "pwsh"},
		{in: "powershell.exe", want: "powershell"},
		{in: "cmd.exe", want: ""},
		{in: "ksh", want: ""},
	} {
		t.Run(tc.in, func(t *testing.T) {
			if got := NormalizeShellIntegrationShell(tc.in); got != tc.want {
				t.Fatalf("expected %q, got %q", tc.want, got)
			}
		})
	}
	if got := NormalizeShell("fish"); got != "" {
		t.Fatalf("fish must remain unsupported for autocomplete snapshots, got %q", got)
	}
}

// 셸별 명령은 **모든 POSIX 셸에서 파싱은 되어야** 한다. 셸을 모를 때 둘을 연달아 보내므로,
// zsh 용이 bash 에서(또는 그 반대로) 문법 오류를 내면 그 줄이 화면에 오류로 남는다.
func TestShellIntegrationInitCommandParses(t *testing.T) {
	commands := map[string]string{
		"bash": strings.TrimRight(BashShellIntegrationInitCommand(), "\r"),
		"zsh":  strings.TrimRight(ZshShellIntegrationInitCommand(), "\r"),
	}
	for _, shell := range []string{"bash", "zsh"} {
		t.Run(shell, func(t *testing.T) {
			path, err := exec.LookPath(shell)
			if err != nil {
				t.Skipf("%s not available", shell)
			}
			// LookPath 는 이름만 본다 — Windows 의 WSL 런처 스텁처럼 실행되지 않는 것도
			// 잡아온다(WSL 기능을 제거하면 HCS_E_SERVICE_NOT_AVAILABLE 로 exit 1 한다).
			// 돌지 않는 셸은 없는 것과 같으니 여기서 갈라낸다.
			if err := exec.Command(path, "-c", "exit 0").Run(); err != nil {
				t.Skipf("%s found at %s but is not runnable: %v", shell, path, err)
			}
			for target, command := range commands {
				if output, err := exec.Command(path, "-n", "-c", command).CombinedOutput(); err != nil {
					t.Fatalf("%s failed to parse the %s init command: %v\n%s", shell, target, err, output)
				}
			}
		})
	}
}

func TestShellIntegrationInitCommandStructure(t *testing.T) {
	for command, wants := range map[string][]string{
		BashShellIntegrationInitCommand(): {
			"BASH_VERSION", `133;%s`, "133;B", "133;C", "PROMPT_COMMAND",
		},
		ZshShellIntegrationInitCommand(): {
			// 명령 원문은 __ds_o 로 `E;<명령>` 을 보낸다 — 문자열에 "133;E" 로 박혀 있지 않다.
			"ZSH_VERSION", `133;%s`, "133;B", `"E;`, "precmd_functions", "preexec_functions",
		},
	} {
		for _, want := range wants {
			if !strings.Contains(command, want) {
				t.Errorf("init command missing %q: %q", want, command)
			}
		}
		if !strings.HasPrefix(command, " ") {
			t.Errorf("init command must start with a space for history hygiene: %q", command)
		}
	}
}

func TestPowerShellIntegrationInitCommandRuns(t *testing.T) {
	path, err := exec.LookPath("powershell.exe")
	if err != nil {
		path, err = exec.LookPath("powershell")
	}
	if err != nil {
		t.Skip("powershell not available")
	}
	command := strings.TrimRight(PowerShellIntegrationInitCommand(), "\r") + "; prompt"
	output, err := exec.Command(path, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command).CombinedOutput()
	if err != nil {
		t.Fatalf("PowerShell failed to run init command: %v\n%s", err, output)
	}
	got := string(output)
	for _, want := range []string{"]133;A", "]133;B", "]7;file:"} {
		if !strings.Contains(got, want) {
			t.Fatalf("PowerShell init output missing %q: %q", want, got)
		}
	}
}

func TestPowerShellIntegrationInitCommandStructure(t *testing.T) {
	command := PowerShellIntegrationInitCommand()
	for _, want := range []string{
		"function global:prompt", "__ds_cwd", "]133;", "]7;",
		"AddToHistoryHandler", "Set-PSReadLineOption",
	} {
		if !strings.Contains(command, want) {
			t.Errorf("PowerShell init command missing %q", want)
		}
	}
	if !strings.HasPrefix(command, " ") {
		t.Error("PowerShell init command must start with a space")
	}
	if !strings.HasSuffix(command, "\r") {
		t.Error("PowerShell init command must end with carriage return")
	}
}

func TestFishShellIntegrationInitCommandRuns(t *testing.T) {
	path, err := exec.LookPath("fish")
	if err != nil {
		t.Skip("fish not available")
	}
	command := strings.TrimRight(FishShellIntegrationInitCommand(), "\r")
	if output, err := exec.Command(path, "-c", command).CombinedOutput(); err != nil {
		t.Fatalf("fish failed to run init command: %v\n%s", err, output)
	}
}

func TestFishShellIntegrationInitCommandStructure(t *testing.T) {
	command := FishShellIntegrationInitCommand()
	for _, want := range []string{
		"fish_prompt", "fish_preexec", "fish_postexec", "]133;A",
		"]133;C", `D;$status`, "]7;file://",
	} {
		if !strings.Contains(command, want) {
			t.Errorf("fish init command missing %q", want)
		}
	}
	if !strings.HasPrefix(command, " ") {
		t.Error("fish init command must start with a space")
	}
	if !strings.HasSuffix(command, "\r") {
		t.Error("fish init command must end with carriage return")
	}
}

func TestHandshakeFilterSuppressesEchoUntilPromptMarker(t *testing.T) {
	var filter HandshakeFilter

	// The injected command echo and the stale prompt are buffered (suppressed).
	if forward, done := filter.Filter([]byte(" __ds_o(){ ...; }; history -d")); len(forward) != 0 || done {
		t.Fatalf("expected echo to be suppressed, got %q done=%v", forward, done)
	}
	// The prompt marker arrives mid-chunk: drop everything before it, forward
	// from the marker onward, and report the handshake as done.
	chunk := []byte("leftover echo\r\n" + PromptStartMarker + "user@host:~$ ")
	forward, done := filter.Filter(chunk)
	if !done {
		t.Fatal("expected handshake to complete on the marker chunk")
	}
	if !strings.HasPrefix(string(forward), PromptStartMarker) {
		t.Fatalf("forwarded bytes should start at the marker, got %q", forward)
	}
	if strings.Contains(string(forward), "leftover echo") || strings.Contains(string(forward), "__ds_o") {
		t.Fatalf("pre-marker echo leaked into output: %q", forward)
	}
	// After the handshake everything passes through untouched.
	if forward, done := filter.Filter([]byte("ls -la\r\n")); string(forward) != "ls -la\r\n" || done {
		t.Fatalf("expected passthrough after handshake, got %q done=%v", forward, done)
	}
}

func TestHandshakeFilterFlushPreservesOutputOnTimeout(t *testing.T) {
	var filter HandshakeFilter
	filter.Filter([]byte("partial output without a marker"))
	flushed := filter.Flush()
	if string(flushed) != "partial output without a marker" {
		t.Fatalf("flush should return buffered output, got %q", flushed)
	}
	if !filter.Done() {
		t.Fatal("filter should be done after flush")
	}
	if forward, _ := filter.Filter([]byte("more")); string(forward) != "more" {
		t.Fatalf("expected passthrough after flush, got %q", forward)
	}
}

func TestHandshakeFilterStripsInjectedEchoAfterMarker(t *testing.T) {
	var filter HandshakeFilter
	// Prompt marker + prompt text + the injected command echoed again as a prompt
	// redraw right after the marker (the slow-host failure mode).
	chunk := append([]byte(PromptStartMarker+"user@host:~$ "), injectedCommandEcho...)
	forward, done := filter.Filter(chunk)
	if !done {
		t.Fatal("expected handshake to complete on the marker chunk")
	}
	if bytes.Contains(forward, injectedCommandEcho) {
		t.Fatalf("injected echo leaked after the marker: %q", forward)
	}
	if !bytes.Contains(forward, []byte("user@host:~$ ")) {
		t.Fatalf("prompt text should be preserved: %q", forward)
	}
}

func TestHandshakeFilterStripsInjectedEchoAfterDone(t *testing.T) {
	var filter HandshakeFilter
	if _, done := filter.Filter([]byte(PromptStartMarker)); !done {
		t.Fatal("expected handshake to complete on the marker")
	}
	chunk := append([]byte("user@host:~$ "), injectedCommandEcho...)
	if forward, _ := filter.Filter(chunk); bytes.Contains(forward, injectedCommandEcho) {
		t.Fatalf("injected echo leaked after the handshake: %q", forward)
	}
}

func TestHandshakeFilterFlushStripsInjectedEcho(t *testing.T) {
	var filter HandshakeFilter
	// Marker never arrives: a login banner and the injected echo accumulate, then
	// the timeout flushes. The banner must survive; the injection must not.
	filter.Filter(append([]byte("login banner\r\n"), injectedCommandEcho...))
	flushed := filter.Flush()
	if bytes.Contains(flushed, injectedCommandEcho) {
		t.Fatalf("injected echo leaked on flush: %q", flushed)
	}
	if !bytes.Contains(flushed, []byte("login banner")) {
		t.Fatalf("real output should survive the flush: %q", flushed)
	}
}

func TestHandshakePassesThroughWhenNotArmed(t *testing.T) {
	var handshake Handshake
	chunk := []byte("fish$ echo hello\r\nhello\r\n")
	if forwarded := handshake.Filter(chunk); !bytes.Equal(forwarded, chunk) {
		t.Fatalf("unarmed handshake should pass through, got %q", forwarded)
	}
	if flushed := handshake.Flush(); len(flushed) != 0 {
		t.Fatalf("unarmed handshake should have nothing to flush, got %q", flushed)
	}
}

// preserveMotd 모드(SSH 로그인 셸): motd는 보존하고 통합 전 첫 프롬프트와 주입 echo만
// 흡수해 통합 프롬프트가 1개만 보여야 한다.
func TestHandshakeFilterPreserveMotdKeepsMotdDropsFirstPrompt(t *testing.T) {
	filter := HandshakeFilter{preserveMotd: true}
	motd := "Welcome to Synology\r\nLast login: Tue Jun 25\r\n"
	// 통합 전 첫 프롬프트와 같은 줄에 주입 명령이 echo된다. 이후 통합 프롬프트(마커)가 온다.
	firstPrompt := "admin@nas:~$ "
	chunk := []byte(motd + firstPrompt + string(injectedCommandEcho) + "\r\n" +
		PromptStartMarker + "admin@nas:~$ ")

	forward, done := filter.Filter(chunk)
	if !done {
		t.Fatal("expected handshake to complete on the marker chunk")
	}
	if !bytes.Contains(forward, []byte("Welcome to Synology")) || !bytes.Contains(forward, []byte("Last login")) {
		t.Fatalf("motd should be preserved: %q", forward)
	}
	if bytes.Contains(forward, injectedCommandEcho) {
		t.Fatalf("injected echo leaked: %q", forward)
	}
	// 통합 프롬프트(마커)는 motd 뒤에 위치해야 한다.
	if mIdx, wIdx := bytes.Index(forward, []byte(PromptStartMarker)), bytes.Index(forward, []byte("Welcome")); mIdx < 0 || wIdx < 0 || mIdx < wIdx {
		t.Fatalf("marker should follow motd: %q", forward)
	}
	// 프롬프트 텍스트는 통합된 것 1개만 — 통합 전 첫 프롬프트는 흡수된다.
	if n := bytes.Count(forward, []byte("admin@nas:~$ ")); n != 1 {
		t.Fatalf("expected exactly one prompt, got %d: %q", n, forward)
	}
}

// preserveMotd 모드: motd가 여러 청크로 쪼개져 와도, 주입 echo가 등장한 시점에 그 직전까지의
// motd를 한 번 흘려보내고 첫 프롬프트~마커는 흡수한다.
func TestHandshakeFilterPreserveMotdForwardsMotdAcrossChunks(t *testing.T) {
	filter := HandshakeFilter{preserveMotd: true}
	// 1) 앵커(echo) 전 motd만 → 아직 아무것도 내보내지 않고 버퍼링한다.
	if forward, done := filter.Filter([]byte("line1\r\nline2\r\n")); len(forward) != 0 || done {
		t.Fatalf("motd before the anchor should buffer, got %q done=%v", forward, done)
	}
	// 2) 프롬프트+echo 도착 → 직전까지의 motd를 흘려보낸다(마커는 아직 없음).
	forward, done := filter.Filter([]byte("nas$ " + string(injectedCommandEcho)))
	if done {
		t.Fatal("handshake should not be done before the marker")
	}
	if string(forward) != "line1\r\nline2\r\n" {
		t.Fatalf("expected buffered motd to flush before the prompt line, got %q", forward)
	}
	// 3) 마커 도착 → 통합 프롬프트만 forward, 첫 프롬프트/echo는 흡수.
	forward, done = filter.Filter([]byte("\r\n" + PromptStartMarker + "nas$ "))
	if !done {
		t.Fatal("expected handshake to complete on the marker")
	}
	if !bytes.HasPrefix(forward, []byte(PromptStartMarker)) {
		t.Fatalf("post-marker forward should start at the marker, got %q", forward)
	}
	if bytes.Contains(forward, injectedCommandEcho) {
		t.Fatalf("injected echo leaked: %q", forward)
	}
}

// preserveMotd 모드 + 비호환 셸(ash 등): 가드로 init 본문이 안 돌아 133;A가 안 온다. motd는
// 앵커 직전에 즉시 노출되고, 나머지(첫 프롬프트+echo)는 Flush에서 echo만 제거되어 나온다
// (통합만 비활성, 화면이 깨지지 않음).
func TestHandshakeFilterPreserveMotdFlushKeepsMotdStripsEcho(t *testing.T) {
	filter := HandshakeFilter{preserveMotd: true}
	forward, _ := filter.Filter([]byte("motd here\r\nash$ " + string(injectedCommandEcho)))
	if !bytes.Contains(forward, []byte("motd here")) {
		t.Fatalf("motd should be forwarded immediately at the anchor: %q", forward)
	}
	flushed := filter.Flush()
	if bytes.Contains(flushed, injectedCommandEcho) {
		t.Fatalf("injected echo must not survive flush: %q", flushed)
	}
	if !bytes.Contains(flushed, []byte("ash$ ")) {
		t.Fatalf("first prompt should survive flush (integration disabled, not broken): %q", flushed)
	}
}

// R8 격리: preserveMotd=false(aws/local/tmux 기존 모드)는 마커 이전 출력을 motd 포함 전부
// 버린다 — SSH 전용 echo-줄 흡수가 다른 transport로 새지 않는지 보장한다.
func TestHandshakeFilterWithoutPreserveMotdDropsEverythingBeforeMarker(t *testing.T) {
	filter := HandshakeFilter{} // preserveMotd=false
	chunk := []byte("banner\r\nuser$ " + string(injectedCommandEcho) + "\r\n" + PromptStartMarker + "user$ ")
	forward, done := filter.Filter(chunk)
	if !done {
		t.Fatal("expected handshake to complete on the marker")
	}
	if bytes.Contains(forward, []byte("banner")) {
		t.Fatalf("non-preserveMotd mode must drop pre-marker output including motd: %q", forward)
	}
	if !bytes.HasPrefix(forward, []byte(PromptStartMarker)) {
		t.Fatalf("forward should start at the marker, got %q", forward)
	}
}

// 셸마다 주입하는 스크립트가 다르므로 걷어낼 echo 도 달라야 한다.
//
// 실기기에서 이렇게 깨졌다: 로컬 PowerShell 에는 pwsh 스크립트를 주입하는데 필터는 bash 문자열을
// 찾아서, 마커 뒤에 오는 프롬프트 재출력이 그대로 화면에 남았다 — 첫 줄에 프롬프트가 두 번 찍히고
// 첫 입력이 엉뚱한 열에서 시작했다.
func TestHandshakeScrubsTheEchoOfTheCommandItArmedWith(t *testing.T) {
	commands := ShellIntegrationInitLines("powershell")
	if len(commands) != 1 {
		t.Fatalf("powershell 통합 명령이 %d개다", len(commands))
	}
	command := commands[0]
	visible := string(visibleInjectedEcho(command))

	var handshake Handshake
	handshake.ArmForCommand(false, command)
	handshake.Filter([]byte("noise" + PromptStartMarker))

	// 마커 뒤에 프롬프트가 명령을 다시 그리는 경우(PSReadLine 재출력).
	forwarded := string(handshake.Filter([]byte("PS /home/user> " + visible + "\r\n")))
	if strings.Contains(forwarded, visible) {
		t.Errorf("주입 명령의 재출력이 화면으로 나갔다: %q", forwarded)
	}
	if !strings.Contains(forwarded, "PS /home/user> ") {
		t.Errorf("프롬프트까지 지웠다: %q", forwarded)
	}
}

// 기본 경로(bash/zsh)는 그대로 동작해야 한다 — Arm 은 기본 echo 를 쓴다.
func TestHandshakeKeepsScrubbingTheDefaultEcho(t *testing.T) {
	var handshake Handshake
	handshake.Arm(false)
	handshake.Filter([]byte(PromptStartMarker))

	visible := string(injectedCommandEcho)
	forwarded := string(handshake.Filter([]byte("user@host:~$ " + visible + "\r\n")))
	if strings.Contains(forwarded, visible) {
		t.Errorf("bash 주입 echo 가 화면으로 나갔다: %q", forwarded)
	}
}

// pwsh 로 무장한 필터가 bash echo 를 지우려 들면 안 된다(반대 방향 회귀).
func TestHandshakeDoesNotScrubAnotherShellsEcho(t *testing.T) {
	command := ShellIntegrationInitLines("powershell")[0]

	var handshake Handshake
	handshake.ArmForCommand(false, command)
	handshake.Filter([]byte(PromptStartMarker))

	// 줄 끝의 개행까지 준다 — 안 주면 스트리머가 "다음 청크에서 pwsh echo 가 이어질 수도 있다" 며
	// 마지막 한 글자를 붙들고 있어(정상 동작) 이 단정만 흔들린다.
	bashEcho := string(injectedCommandEcho)
	forwarded := string(handshake.Filter([]byte(bashEcho + "\r\n")))
	if !strings.Contains(forwarded, bashEcho) {
		t.Error("pwsh 로 무장했는데 bash 텍스트를 지웠다")
	}
}
