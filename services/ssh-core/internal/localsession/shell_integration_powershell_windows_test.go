//go:build windows

package localsession

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/protocol"
)

// 로컬 PowerShell 을 실제 ConPTY 로 띄워 OSC 133 마커를 확인한다.
//
// 실기기에서 두 가지가 깨져 있었고, 둘 다 여기서만 보인다 — 스크립트 문자열을 읽어서는 알 수
// 없고 PSReadLine 이 붙은 대화형 셸이 있어야 드러난다:
//
//  1. 명령 시작(C)이 AddToHistoryHandler 에 걸려 있어서, PSReadLine 이 기동 시 히스토리 파일을
//     읽는 동안 **줄마다** C 가 나왔다. 입력을 하나도 안 했는데 C 가 수백 개 오고, 짝이 되는 D 가
//     없어 블록이 전부 running 으로 남았다. running 블록은 끝을 모르니 화면 끝까지 칠해진다 —
//     터미널을 열면 화면 전체가 한 블록이던 증상이 이것이다.
//
//  2. B(입력 시작)가 프롬프트보다 **먼저** 나왔다. 앱은 B 시점의 커서 열을 "프롬프트가 끝난
//     자리"로 기록하므로 그 값이 0 이 되고, 화면에서 명령을 읽을 때 프롬프트까지 읽혀
//     재실행·복사에 `PS C:\Users\...> pwd` 가 들어갔다.
//
// 히스토리는 테스트가 심는다(APPDATA 를 임시 디렉터리로 돌린다) — 개발자 머신의 히스토리 길이에
// 결과가 좌우되면 회귀를 못 잡는다.
func TestLocalPowerShellShellIntegrationMarkers(t *testing.T) {
	shellRuntime, err := resolveWindowsShellRuntime()
	if err != nil {
		t.Skipf("사용할 수 있는 Windows 셸이 없다: %v", err)
	}
	if shellRuntime.kind != windowsShellKindPwsh && shellRuntime.kind != windowsShellKindPowerShell {
		t.Skipf("PowerShell 이 아니다(kind=%s) — 통합 대상이 아니다", shellRuntime.kind)
	}
	args, preinstalled := withShellIntegrationArgs(shellRuntime.kind, shellRuntime.args)
	if !preinstalled {
		t.Fatal("기동 인자로 통합이 들어가지 않았다")
	}

	const historyLines = 300
	appData := seedPSReadLineHistory(t, shellRuntime.kind, historyLines)

	runner, err := startPlatformLocalRunner(protocol.LocalConnectPayload{Cols: 120, Rows: 30}, localCommandRuntime{
		shellKind:                    shellRuntime.kind,
		executablePath:               shellRuntime.executablePath,
		args:                         args,
		env:                          append(os.Environ(), "APPDATA="+appData),
		wrapperPath:                  buildConPTYWrapperBinary(t),
		workingDirectory:             t.TempDir(),
		shellIntegrationPreinstalled: preinstalled,
	})
	if err != nil {
		t.Fatalf("로컬 셸을 띄우지 못했다: %v", err)
	}
	defer func() {
		_ = runner.Kill()
		_ = runner.Close()
	}()

	captured := &capturedOutput{}
	for _, stream := range runner.Streams() {
		go copyReaderOutput(captured, stream)
	}

	// 첫 프롬프트까지 기다린다. B 는 프롬프트 **뒤**에 오므로 그것이 보이면 한 바퀴가 끝난 것이다.
	if !waitFor(t, 30*time.Second, func() bool {
		return strings.Contains(captured.snapshot(), "\x1b]133;B\x07")
	}) {
		t.Fatalf("첫 프롬프트 마커가 오지 않았다: %q", visibleMarkers(captured.snapshot()))
	}
	// 프롬프트가 다 그려질 시간을 준다 — 히스토리 로드가 늦게 발화하면 여기서 잡힌다.
	time.Sleep(2 * time.Second)

	startup := captured.snapshot()

	// 1번 회귀: 입력이 없었으므로 명령 시작은 없다. 히스토리 300줄이 C 로 새면 여기서 걸린다.
	if got := strings.Count(startup, "\x1b]133;C\x07"); got != 0 {
		t.Errorf(
			"입력 없이 C 가 %d 개 왔다(히스토리 %d줄) — 명령 블록이 유령으로 생긴다",
			got, historyLines,
		)
	}
	// 2번 회귀: B 는 프롬프트 문자열 바로 뒤여야 한다. 기본 프롬프트는 `> ` 로 끝난다.
	if !strings.Contains(startup, "> \x1b]133;B\x07") {
		t.Errorf(
			"B 가 프롬프트 뒤에 오지 않았다 — 화면에서 명령을 읽을 때 프롬프트가 섞인다: %q",
			visibleMarkers(startup),
		)
	}
	// 프롬프트 한 바퀴의 나머지도 확인한다(D → A → cwd 순).
	for _, want := range []string{"\x1b]133;D;0\x07", "\x1b]133;A\x07", "\x1b]7;file:"} {
		if !strings.Contains(startup, want) {
			t.Errorf("첫 프롬프트에 %q 가 없다: %q", want, visibleMarkers(startup))
		}
	}

	// 명령 한 줄. 셸이 받아들인 원문이 E 로 오고(zsh 와 같은 계약) C·D 가 한 번씩 따라온다.
	if err := runner.Write([]byte("pwd\r")); err != nil {
		t.Fatalf("입력을 쓰지 못했다: %v", err)
	}
	if !waitFor(t, 20*time.Second, func() bool {
		return strings.Contains(captured.snapshot()[len(startup):], "\x1b]133;D;0\x07")
	}) {
		t.Fatalf("명령이 끝나지 않았다: %q", visibleMarkers(captured.snapshot()[len(startup):]))
	}
	time.Sleep(500 * time.Millisecond)
	command := captured.snapshot()[len(startup):]

	if got := strings.Count(command, "\x1b]133;C\x07"); got != 1 {
		t.Errorf("명령 하나에 C 가 %d 개 왔다: %q", got, visibleMarkers(command))
	}
	if !strings.Contains(command, "\x1b]133;E;pwd\x07") {
		t.Errorf("명령 원문(E;pwd)이 오지 않았다: %q", visibleMarkers(command))
	}

	// 빈 엔터는 명령이 아니다 — bash·zsh 도 그때 C 를 내지 않는다. 내면 프롬프트만 다시 뜨는
	// 자리에 빈 블록이 생긴다.
	before := captured.snapshot()
	if err := runner.Write([]byte("\r")); err != nil {
		t.Fatalf("빈 엔터를 쓰지 못했다: %v", err)
	}
	if !waitFor(t, 20*time.Second, func() bool {
		return strings.Contains(captured.snapshot()[len(before):], "\x1b]133;B\x07")
	}) {
		t.Fatalf("빈 엔터 뒤 프롬프트가 오지 않았다: %q", visibleMarkers(captured.snapshot()[len(before):]))
	}
	if got := strings.Count(captured.snapshot()[len(before):], "\x1b]133;C\x07"); got != 0 {
		t.Errorf("빈 엔터에 C 가 %d 개 왔다", got)
	}
}

// 실패한 명령의 종료 코드가 D 로 온다. prompt 안에서 `$?` 를 첫 문장에서 잡아야 성립한다 —
// 그 앞에 문장이 하나라도 끼면 값이 갈아치워져 전부 성공으로 보인다.
func TestLocalPowerShellReportsFailingExitCode(t *testing.T) {
	shellRuntime, err := resolveWindowsShellRuntime()
	if err != nil {
		t.Skipf("사용할 수 있는 Windows 셸이 없다: %v", err)
	}
	if shellRuntime.kind != windowsShellKindPwsh && shellRuntime.kind != windowsShellKindPowerShell {
		t.Skipf("PowerShell 이 아니다(kind=%s)", shellRuntime.kind)
	}
	args, preinstalled := withShellIntegrationArgs(shellRuntime.kind, shellRuntime.args)

	runner, err := startPlatformLocalRunner(protocol.LocalConnectPayload{Cols: 120, Rows: 30}, localCommandRuntime{
		shellKind:                    shellRuntime.kind,
		executablePath:               shellRuntime.executablePath,
		args:                         args,
		env:                          append(os.Environ(), "APPDATA="+seedPSReadLineHistory(t, shellRuntime.kind, 0)),
		wrapperPath:                  buildConPTYWrapperBinary(t),
		workingDirectory:             t.TempDir(),
		shellIntegrationPreinstalled: preinstalled,
	})
	if err != nil {
		t.Fatalf("로컬 셸을 띄우지 못했다: %v", err)
	}
	defer func() {
		_ = runner.Kill()
		_ = runner.Close()
	}()

	captured := &capturedOutput{}
	for _, stream := range runner.Streams() {
		go copyReaderOutput(captured, stream)
	}
	if !waitFor(t, 30*time.Second, func() bool {
		return strings.Contains(captured.snapshot(), "\x1b]133;B\x07")
	}) {
		t.Fatalf("첫 프롬프트 마커가 오지 않았다: %q", visibleMarkers(captured.snapshot()))
	}
	before := captured.snapshot()

	if err := runner.Write([]byte("dolgate-no-such-command\r")); err != nil {
		t.Fatalf("입력을 쓰지 못했다: %v", err)
	}
	if !waitFor(t, 20*time.Second, func() bool {
		return strings.Contains(captured.snapshot()[len(before):], "\x1b]133;D;")
	}) {
		t.Fatalf("명령이 끝나지 않았다: %q", visibleMarkers(captured.snapshot()[len(before):]))
	}
	tail := captured.snapshot()[len(before):]
	if strings.Contains(tail, "\x1b]133;D;0\x07") {
		t.Errorf("실패한 명령이 성공으로 보고됐다: %q", visibleMarkers(tail))
	}
}

// seedPSReadLineHistory 는 PSReadLine 이 기동 시 읽을 히스토리 파일을 심고 그 APPDATA 를 준다.
// Windows PowerShell 과 pwsh 는 저장 경로의 셸 이름이 다르므로 둘 다 심는다.
func seedPSReadLineHistory(t *testing.T, shellKind string, lines int) string {
	t.Helper()
	appData := t.TempDir()
	hosts := []string{"PowerShell"}
	if shellKind == windowsShellKindPwsh {
		hosts = append(hosts, "powershell")
	}
	body := &strings.Builder{}
	for index := 0; index < lines; index++ {
		fmt.Fprintf(body, "Write-Output seeded-%d\n", index)
	}
	for _, host := range hosts {
		directory := filepath.Join(appData, "Microsoft", "Windows", host, "PSReadLine")
		if err := os.MkdirAll(directory, 0o755); err != nil {
			t.Fatalf("히스토리 디렉터리를 만들지 못했다: %v", err)
		}
		path := filepath.Join(directory, "ConsoleHost_history.txt")
		if err := os.WriteFile(path, []byte(body.String()), 0o644); err != nil {
			t.Fatalf("히스토리 파일을 쓰지 못했다: %v", err)
		}
	}
	return appData
}

// buildConPTYWrapperBinary 는 프로덕션이 쓰는 래퍼를 빌드한다. 래퍼 없이 셸을 띄우면 자식이
// 가상 콘솔에 붙지 않아 출력이 파이프로 오지 않는다 — 마커를 하나도 볼 수 없다.
func buildConPTYWrapperBinary(t *testing.T) string {
	t.Helper()
	wrapperPath := filepath.Join(t.TempDir(), localConPTYWrapperBinaryName)
	build := exec.Command("go", "build", "-o", wrapperPath, "./cmd/aws-conpty-wrapper")
	build.Dir = filepath.Join("..", "..")
	build.Env = append(os.Environ(), "CGO_ENABLED=0")
	if result, err := build.CombinedOutput(); err != nil {
		t.Fatalf("conpty 래퍼를 빌드하지 못했다: %v\n%s", err, result)
	}
	return wrapperPath
}

// 실패 메시지에 담을 형태. 마커가 눈에 보여야 무엇이 틀렸는지 읽을 수 있다.
//
// 되풀이는 접는다 — 유령 C 가 수백 개 나오는 것이 바로 이 테스트가 잡는 회귀라, 접지 않으면
// 실패 메시지가 그 마커로만 수천 자가 되어 나머지가 안 보인다.
func visibleMarkers(value string) string {
	visible := strings.NewReplacer(
		"\x1b", "<ESC>", "\x07", "<BEL>", "\r", "<CR>", "\n", "<LF>",
	).Replace(value)
	for _, marker := range []string{"A", "B", "C"} {
		visible = collapseRepeats(visible, "<ESC>]133;"+marker+"<BEL>")
	}
	if len(visible) > 1200 {
		visible = "…" + visible[len(visible)-1200:]
	}
	return visible
}

func collapseRepeats(value string, unit string) string {
	builder := &strings.Builder{}
	for {
		at := strings.Index(value, unit)
		if at < 0 {
			builder.WriteString(value)
			return builder.String()
		}
		builder.WriteString(value[:at])
		value = value[at:]
		count := 0
		for strings.HasPrefix(value, unit) {
			count++
			value = value[len(unit):]
		}
		builder.WriteString(unit)
		if count > 1 {
			fmt.Fprintf(builder, "×%d", count)
		}
	}
}
