package autocomplete

import (
	"bytes"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/creack/pty"
)

// 진짜 셸에 주입해 보는 테스트.
//
// 이 파일이 있는 이유: 셸 통합은 지금까지 문자열 단위로만 검증됐는데, 깨지는 자리는 늘
// "그 바이트를 진짜 셸이 어떻게 읽느냐" 였다. bash 에서 되는 스크립트가 dash 에서 화면을
// 더럽히는 것을 사람이 발견하고 나서야 알았다(도커 컨테이너의 busybox sh 로 들어갔을 때).
//
// 그래서 여기서는 실제 PTY 에 대화형 셸을 띄우고, 우리가 보내는 바이트를 그대로 써 넣은 뒤
// **핸드셰이크 필터를 통과한 결과**를 본다. 사용자가 보는 것이 정확히 그것이기 때문이다.
//
// 셸이 없는 환경에서는 건너뛴다 — 있는 기계에서만 지켜도 이 계열의 재발은 대부분 막힌다.

// shellSession 은 PTY 에 띄운 대화형 셸이다.
//
// 읽기를 고루틴으로 빼는 이유: macOS 에서 PTY 마스터는 SetReadDeadline 이 먹지 않아 Read 가
// 영원히 블록한다(그렇게 한 번 600초를 날렸다). 계속 읽어 모아 두고, 조용해질 때까지 기다리는
// 쪽이 이식성이 있다.
type shellSession struct {
	file *os.File
	mu   sync.Mutex
	out  []byte
	// fish 는 프롬프트를 그릴 때마다 터미널에 묻고(DA1·커서 위치·배경색) 답을 기다린다.
	// 답이 없으면 시한이 지날 때까지 아무것도 안 그린다 — 여기엔 에뮬레이터가 없으니 대신 답한다.
	answerTerminalQueries bool
}

// terminalQueryAnswers 는 질의별로 돌려줄 최소한의 답이다.
var terminalQueryAnswers = []struct{ query, answer string }{
	{"\x1b[0c", "\x1b[?62;c"},
	{"\x1b[6n", "\x1b[1;1R"},
	{"\x1b]11;?", "\x1b]11;rgb:0000/0000/0000\x1b\\"},
}

// noRcArgs 는 그 셸에서 rc 파일을 끄는 인자다. 모르는 셸이면 아무것도 주지 않는다.
func noRcArgs(name string) []string {
	switch name {
	case "bash", "sh":
		return []string{"--norc", "--noprofile"}
	case "zsh":
		return []string{"--no-rcs"}
	case "fish":
		// fish 는 설정을 읽으면 이 기계의 자동완성 바이너리를 띄우다 죽는다(bash 와 같은 이유).
		return []string{"--no-config"}
	default:
		return nil
	}
}

func startShell(t *testing.T, name string) (*shellSession, func()) {
	t.Helper()
	path, err := exec.LookPath(name)
	if err != nil {
		t.Skipf("%s 가 없다", name)
	}
	// rc 파일을 읽히지 않는다. 개발자 dotfile 이 결과를 흔들면 안 되고, 실제로 한 번 당했다 —
	// 여기 bash 의 ~/.bashrc 가 띄우는 자동완성 바이너리가 PTY 안에서 panic 하며 셸을 끌고
	// 내려가, 우리 스크립트가 셸을 죽인 것처럼 보였다.
	cmd := exec.Command(path, append(noRcArgs(name), "-i")...)
	// 프롬프트를 예측 가능하게 고정한다. PS2 는 여러 줄 명령의 계속 프롬프트다.
	// ENV·BASH_ENV 는 dash·bash 가 비대화형에서도 읽는 초기화 파일이라 함께 비운다.
	cmd.Env = append(
		os.Environ(),
		"PS1=$ ", "PS2=> ", "TERM=xterm-256color", "HISTFILE=", "ENV=", "BASH_ENV=",
	)
	file, err := pty.Start(cmd)
	if err != nil {
		t.Skipf("%s 를 PTY 로 띄우지 못했다: %v", name, err)
	}
	session := &shellSession{file: file}
	// fish 는 기동하면서 터미널에 질의를 던지고 답을 기다린다(DA1·커서 위치). 여기에는 답할
	// 에뮬레이터가 없으므로 최소한의 답을 대신 넣어 준다 — 안 그러면 프롬프트조차 안 그린다.
	// **fish 에만** 답한다. 묻지 않은 셸에 보내면 그냥 타이핑한 글자가 되어 프로브 줄이 망가진다.
	session.answerTerminalQueries = name == "fish"
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := file.Read(buf)
			if n > 0 {
				chunk := buf[:n]
				session.mu.Lock()
				session.out = append(session.out, chunk...)
				answer := session.answerTerminalQueries
				session.mu.Unlock()
				if answer {
					for _, pair := range terminalQueryAnswers {
						if bytes.Contains(chunk, []byte(pair.query)) {
							_, _ = file.WriteString(pair.answer)
						}
					}
				}
			}
			if err != nil {
				return
			}
		}
	}()
	return session, func() {
		_ = file.Close()
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	}
}

func (s *shellSession) write(t *testing.T, text string) {
	t.Helper()
	if _, err := s.file.WriteString(text); err != nil {
		// 셸이 이미 죽었다는 뜻이다. 왜 죽었는지는 죽기 전 출력에 있다.
		s.mu.Lock()
		tail := string(s.out)
		s.mu.Unlock()
		t.Fatalf("write: %v\n--- 셸이 남긴 것 ---\n%s", err, tail)
	}
}

// take 는 조용해질 때까지 기다렸다가 그동안 모인 것을 가져간다(그리고 비운다).
func (s *shellSession) take(quiet time.Duration) []byte {
	deadline := time.Now().Add(3 * time.Second)
	last := -1
	for time.Now().Before(deadline) {
		s.mu.Lock()
		size := len(s.out)
		s.mu.Unlock()
		if size == last && size > 0 {
			break
		}
		last = size
		time.Sleep(quiet)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.out
	s.out = nil
	return out
}

// injectThroughFilter 는 실제 주입 경로를 그대로 흉내 낸다: 핸드셰이크를 무장하고, 줄들을
// 써 넣고, 셸이 뱉은 것을 필터에 통과시켜 **사용자에게 보일 바이트**를 돌려준다.
func injectThroughFilter(t *testing.T, shellName string, lines []string) string {
	t.Helper()
	session, stop := startShell(t, shellName)
	defer stop()

	// 로그인 출력·첫 프롬프트를 흘려보낸다. fish 는 기동이 느려 넉넉히 기다린다.
	session.take(250 * time.Millisecond)

	handshake := &Handshake{}
	handshake.ArmForCommand(false, lines...)
	for _, line := range lines {
		session.write(t, line)
		time.Sleep(80 * time.Millisecond)
	}

	raw := session.take(120 * time.Millisecond)
	visible := handshake.Filter(raw)
	// 마커가 끝내 오지 않는 셸(dash 등)에서는 시한이 지나면 Flush 로 풀린다 — 실제 세션도
	// 그렇게 동작하므로 여기서도 같이 본다.
	visible = append(visible, handshake.Flush()...)
	return string(visible)
}

// 주입 스크립트에서 화면에 나오면 안 되는 조각들. 사용자가 본 그 문자열이다.
var scriptFingerprints = []string{
	"__ds_o()",
	"BASH_VERSION",
	"ZSH_VERSION",
	"__ds_precmd",
}

func assertNothingLeaked(t *testing.T, shellName string, visible string) {
	t.Helper()
	for _, fingerprint := range scriptFingerprints {
		if strings.Contains(visible, fingerprint) {
			t.Errorf(
				"%s: 주입 스크립트가 화면에 남았다 (%q 발견)\n--- 보이는 것 ---\n%s",
				shellName, fingerprint, visible,
			)
			return
		}
	}
	if strings.Contains(visible, "> ") && strings.Count(visible, "> ") > 1 {
		t.Errorf("%s: PS2 계속 프롬프트가 화면에 남았다\n--- 보이는 것 ---\n%s", shellName, visible)
	}
}

// bash·zsh: 통합이 실제로 붙어야 한다(마커가 온다). 그리고 스크립트는 안 보여야 한다.
func TestShellIntegrationInstallsInRealShell(t *testing.T) {
	for _, shellName := range []string{"bash", "zsh"} {
		t.Run(shellName, func(t *testing.T) {
			session, stop := startShell(t, shellName)
			defer stop()
			session.take(100 * time.Millisecond)

			for _, line := range ShellIntegrationInitLines(shellName) {
				session.write(t, line)
			}
			session.take(120 * time.Millisecond)

			// 아무 명령이나 실행하면 프롬프트 마커가 따라와야 한다.
			session.write(t, "true\r")
			out := session.take(120 * time.Millisecond)
			if !bytes.Contains(out, []byte(PromptStartMarker)) {
				t.Fatalf("%s: 통합이 붙지 않았다 — OSC 133;A 가 오지 않았다\n%q", shellName, out)
			}
		})
	}
}

// 프로브 → 그 셸 전용 주입. 다섯 셸 모두에서 **화면에 아무것도 남으면 안 된다.**
//
// 도커 컨테이너(busybox sh)에서 스크립트 전문이 그대로 찍힌 그 증상을 여기서 잡는다.
func TestShellProbeLeavesNothingOnScreen(t *testing.T) {
	for _, shellName := range []string{"dash", "sh", "bash", "zsh", "fish"} {
		t.Run(shellName, func(t *testing.T) {
			session, stop := startShell(t, shellName)
			defer stop()
			session.take(100 * time.Millisecond)

			// 1) 프로브 한 줄.
			probe := ShellProbeCommand()
			handshake := &Handshake{}
			handshake.ArmForShellProbe(false, probe)
			session.write(t, probe)
			raw := session.take(120 * time.Millisecond)
			visible := string(handshake.Filter(raw))

			resolved, _, ok := ParseShellProbeReply(raw)
			if !ok {
				t.Fatalf("%s: 프로브 답이 오지 않았다\n%q", shellName, raw)
			}
			if strings.Contains(visible, ShellProbeReplyPrefix) {
				t.Errorf("%s: 프로브 답이 화면으로 새어 나갔다: %q", shellName, visible)
			}
			assertNothingLeaked(t, shellName+"(프로브)", visible)

			// 2) 알아낸 셸 전용 주입. 지원하지 않는 셸이면 보낼 것이 없어야 한다.
			lines := ShellIntegrationInitLines(resolved)
			if resolved == "" {
				if len(lines) != 0 {
					t.Fatalf("%s: 지원 대상이 아닌데 %d줄을 보내려 한다", shellName, len(lines))
				}
				return
			}
			handshake.ArmForCommand(true, lines...)
			for _, line := range lines {
				session.write(t, line)
			}
			raw = session.take(120 * time.Millisecond)
			assertNothingLeaked(t, shellName+"(주입)", string(handshake.Filter(raw)))

			// 3) 실제로 붙었는지. 아무 명령이나 실행하면 마커가 따라와야 한다.
			session.write(t, "true\r")
			out := session.take(120 * time.Millisecond)
			if !bytes.Contains(out, []byte(PromptStartMarker)) {
				t.Errorf("%s: 통합이 붙지 않았다 — OSC 133;A 가 오지 않았다\n%q", shellName, out)
			}
		})
	}
}

// 셸을 모를 때 겸용 스크립트를 보내던 길은 없어졌다. 되살아나면 dash 화면이 다시 더러워진다.
func TestUnknownShellSendsNothingWithoutAsking(t *testing.T) {
	if lines := ShellIntegrationInitLines(""); len(lines) != 0 {
		t.Fatalf("셸을 모르는데 %d줄을 보내려 한다 — 먼저 물어봐야 한다", len(lines))
	}
}

// fish 는 명령 원문을 133;E 로 알려 줘야 한다.
//
// fish 는 B(프롬프트 끝)를 프롬프트가 그려지기 **전**에 내보내서, 앱이 화면에서 명령을 읽으면
// 프롬프트까지 함께 읽힌다 — 재실행하면 `ubuntu@ubuntu ~> pwd` 가 통째로 입력됐다. 원문을 받으면
// 화면을 읽지 않으므로 그 자리가 사라진다.
func TestFishReportsTheCommandItRan(t *testing.T) {
	session, stop := startShell(t, "fish")
	defer stop()
	session.take(250 * time.Millisecond)
	session.write(t, FishShellIntegrationInitCommand())
	session.take(250 * time.Millisecond)

	session.write(t, "echo hi\r")
	out := string(session.take(250 * time.Millisecond))
	const prefix = "\x1b]133;E;"
	index := strings.Index(out, prefix)
	if index < 0 {
		t.Fatalf("133;E 가 오지 않았다: %q", out)
	}
	rest := out[index+len(prefix):]
	end := strings.IndexByte(rest, '\a')
	if end < 0 {
		t.Fatalf("133;E 가 끝나지 않았다: %q", rest)
	}
	if got := rest[:end]; got != "echo hi" {
		t.Fatalf("보고된 원문이 다르다: %q", got)
	}
}
