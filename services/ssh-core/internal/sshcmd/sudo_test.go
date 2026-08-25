package sshcmd

import (
	"errors"
	"os/exec"
	"runtime"
	"strings"
	"testing"
)

// 비밀번호는 **인자가 아니라 stdin** 으로 가야 한다. 명령줄에 넣으면 원격의 `ps` 와 감사
// 로그에 그대로 남는다.
func TestBuildSudoCommandKeepsThePasswordOutOfTheCommandLine(t *testing.T) {
	invocation, err := BuildSudoCommand("docker ps -q", "s3cr3t")
	if err != nil {
		t.Fatalf("BuildSudoCommand() error = %v", err)
	}
	lines := strings.Split(invocation.Script, "\n")
	if len(lines) < 3 {
		t.Fatalf("expected a heredoc, got %q", invocation.Script)
	}
	// 첫 줄이 실제로 실행되는 명령이다 — 여기에 비밀번호가 있으면 안 된다.
	if strings.Contains(lines[0], "s3cr3t") {
		t.Fatalf("password leaked into the command line: %q", lines[0])
	}
	if !strings.Contains(lines[0], "sudo -S -p ''") {
		t.Fatalf("expected a prompt-less sudo -S, got %q", lines[0])
	}
	// 비밀번호는 히어독의 본문으로만 나타난다.
	if lines[1] != "s3cr3t" {
		t.Fatalf("expected the password as heredoc data, got %q", lines[1])
	}
}

func TestBuildSudoCommandRefusesWithoutAPassword(t *testing.T) {
	if _, err := BuildSudoCommand("docker ps -q", ""); !errors.Is(err, ErrSudoPasswordUnavailable) {
		t.Fatalf("expected ErrSudoPasswordUnavailable, got %v", err)
	}
}

// 비밀번호에 줄바꿈이 섞여 오면 뒷줄이 명령으로 흘러 들어갈 수 있다 — 첫 줄만 쓴다.
func TestBuildSudoCommandTakesOnlyTheFirstLine(t *testing.T) {
	invocation, err := BuildSudoCommand("id -u", "first\nrm -rf /")
	if err != nil {
		t.Fatalf("BuildSudoCommand() error = %v", err)
	}
	if strings.Contains(invocation.Script, "rm -rf /") {
		t.Fatalf("the second line survived: %q", invocation.Script)
	}
}

// 실제 셸에서 돌려 본다: 감싼 명령이 그대로 실행되고, 비밀번호 줄은 명령으로 새지 않는다.
// (sudo 자체는 쓰지 않는다 — 테스트가 권한을 요구하면 안 된다.)
func TestBuildSudoCommandShapeRunsUnderSh(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell required")
	}
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("sh not available")
	}
	invocation, err := BuildSudoCommand("printf ran", "p@ss'word\"$(id)")
	if err != nil {
		t.Fatalf("BuildSudoCommand() error = %v", err)
	}
	// sudo 를 우리 스텁으로 바꿔 실행한다: 첫 줄(비밀번호)을 읽어 버리고 -c 뒤의 명령을 돈다.
	// -S -p '' 를 걷어내면 남는 것이 `sh -c <명령>` 이다. 첫 줄(비밀번호)은 읽어 버린다.
	stub := "sudo() { read _password; shift 3; \"$@\"; }\n"
	output, err := exec.Command("sh", "-c", stub+invocation.Script).Output()
	if err != nil {
		t.Fatalf("command did not run cleanly: %v", err)
	}
	stripped, ok := StripSudoMarker(output, invocation.OKMarker)
	if !ok {
		t.Fatalf("marker missing from %q", string(output))
	}
	if string(stripped) != "ran" {
		t.Fatalf("wrapped command output = %q, want %q", string(stripped), "ran")
	}
}

/**
 * **"출력이 비었다" 로 sudo 거절을 판정하면 안 된다.**
 *
 * 컨테이너가 하나도 없는 호스트의 `docker ps -a` 도 정상적으로 아무것도 찍지 않는다. 예전에는
 * 그것을 거절로 읽고 세션의 sudo 를 영영 막아, 화면이 "다시 받는 중" 에서 못 빠져나왔다.
 * 표식은 sudo 가 명령을 **시작했는지**만 말하므로 출력의 양과 무관하다.
 */
func TestStripSudoMarkerSeparatesRefusalFromEmptyOutput(t *testing.T) {
	invocation, err := BuildSudoCommand("docker ps -a", "s3cr3t")
	if err != nil {
		t.Fatalf("BuildSudoCommand() error = %v", err)
	}

	// 명령이 돌았고 아무것도 찍지 않았다(컨테이너 0개) — 거절이 아니다.
	output, ok := StripSudoMarker([]byte(invocation.OKMarker), invocation.OKMarker)
	if !ok {
		t.Fatal("an empty result with the marker must not read as a refusal")
	}
	if len(output) != 0 {
		t.Fatalf("stripped output = %q, want empty", output)
	}

	// 명령이 돌았고 줄이 있다.
	output, ok = StripSudoMarker([]byte(invocation.OKMarker+"abc\tweb\n"), invocation.OKMarker)
	if !ok || string(output) != "abc\tweb\n" {
		t.Fatalf("stripped output = %q ok = %v", output, ok)
	}

	// 표식이 없다 = sudo 가 명령을 시작하지도 못했다 = 거절.
	if _, ok = StripSudoMarker(nil, invocation.OKMarker); ok {
		t.Fatal("a missing marker must read as a refusal")
	}
}

// 표식은 명령보다 **먼저** 찍혀야 한다 — 명령이 실패하거나 아무것도 안 찍어도 sudo 가 통했다는
// 사실은 남아야 하기 때문이다.
func TestBuildSudoCommandPrintsTheMarkerBeforeTheCommand(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell required")
	}
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("sh not available")
	}
	// 아무것도 찍지 않고 실패하는 명령.
	invocation, err := BuildSudoCommand("false", "s3cr3t")
	if err != nil {
		t.Fatalf("BuildSudoCommand() error = %v", err)
	}
	stub := "sudo() { read _password; shift 3; \"$@\"; }\n"
	output, _ := exec.Command("sh", "-c", stub+invocation.Script).Output()
	if _, ok := StripSudoMarker(output, invocation.OKMarker); !ok {
		t.Fatalf("marker missing for a command that ran and printed nothing: %q", output)
	}
}
