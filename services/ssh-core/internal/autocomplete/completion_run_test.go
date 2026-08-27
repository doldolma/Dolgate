package autocomplete

import (
	"errors"
	"regexp"
	"strings"
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/sshcmd"
)

// 승격은 세션 종류마다 따로 구현하면 한쪽만 되는 일이 생긴다(실제로 tmux 에서 도커를 못 읽었다).
// 여기서 한 번 검사해 두면 그 경로를 쓰는 모든 연결이 같은 규칙을 따른다.

var okMarkerPattern = regexp.MustCompile(`__DOLGATE_SUDO_OK_[0-9a-f]+__`)

func TestRunCompletionWithoutPasswordNeverTouchesRemote(t *testing.T) {
	calls := 0
	target := CompletionTarget{
		Run: func(string, bool) ([]byte, bool, error) {
			calls++
			return nil, false, nil
		},
		// 키·에이전트로 붙은 연결이거나 이미 거절당한 뒤 — 되물릴 값이 없다.
		SudoPassword: func() string { return "" },
	}

	_, _, err := RunCompletion(target, "docker ps -a", true, true)

	if !errors.Is(err, sshcmd.ErrSudoPasswordUnavailable) {
		t.Fatalf("되물릴 값이 없으면 그 자리에서 끝나야 한다: %v", err)
	}
	if calls != 0 {
		t.Fatalf("원격을 건드리지 않아야 한다: %d 회 실행됨", calls)
	}
}

func TestRunCompletionElevatesAndStripsMarker(t *testing.T) {
	var ran string
	target := CompletionTarget{
		Run: func(command string, _ bool) ([]byte, bool, error) {
			ran = command
			// sudo 가 명령을 시작하면 표식이 먼저 찍힌다.
			marker := okMarkerPattern.FindString(command)
			if marker == "" {
				t.Fatalf("표식이 스크립트에 없다: %q", command)
			}
			return []byte(marker + "CONTAINER ID\n"), false, nil
		},
		SudoPassword: func() string { return "hunter2" },
	}

	out, _, err := RunCompletion(target, "docker ps -a", true, true)

	if err != nil {
		t.Fatalf("승격이 통해야 한다: %v", err)
	}
	if out != "CONTAINER ID\n" {
		t.Fatalf("표식을 걷어낸 원문이어야 한다: %q", out)
	}
	if !strings.Contains(ran, "sudo -S -p ''") {
		t.Fatalf("sudo 로 감싸야 한다: %q", ran)
	}
	if strings.Contains(ran, "hunter2 ") || strings.Contains(ran, "sudo -S -p '' hunter2") {
		t.Fatalf("비밀번호가 인자로 나가면 안 된다(ps 에 남는다): %q", ran)
	}
}

func TestRunCompletionDeniesOnceWhenSudoRefuses(t *testing.T) {
	denied := 0
	target := CompletionTarget{
		// 표식이 없다 = sudo 가 명령을 시작하지도 못했다.
		Run:          func(string, bool) ([]byte, bool, error) { return []byte(""), false, nil },
		SudoPassword: func() string { return "wrong" },
		DenySudo:     func() { denied++ },
	}

	_, _, err := RunCompletion(target, "docker ps -a", true, true)

	if !errors.Is(err, sshcmd.ErrSudoRefused) {
		t.Fatalf("거절로 판정해야 한다: %v", err)
	}
	if denied != 1 {
		t.Fatalf("이 연결에서 다시 내밀지 않게 한 번 잠가야 한다: %d", denied)
	}
}

func TestRunCompletionKeepsRoundTripFailureUndecided(t *testing.T) {
	// 왕복 자체가 실패한 것은 "비밀번호가 틀렸다" 가 아니다 — 여기서 잠그면 멀쩡한 호스트가 막힌다.
	denied := 0
	boom := errors.New("lane busy")
	target := CompletionTarget{
		Run:          func(string, bool) ([]byte, bool, error) { return nil, false, boom },
		SudoPassword: func() string { return "hunter2" },
		DenySudo:     func() { denied++ },
	}

	_, _, err := RunCompletion(target, "docker ps -a", true, true)

	if !errors.Is(err, boom) {
		t.Fatalf("왕복 오류를 그대로 올려야 한다: %v", err)
	}
	if denied != 0 {
		t.Fatalf("거절로 단정하면 안 된다: %d", denied)
	}
}

func TestRunCompletionFallsBackWhenWorkerChannelIsUnavailable(t *testing.T) {
	target := CompletionTarget{
		Run: func(string, bool) ([]byte, bool, error) {
			return nil, false, sshcmd.ErrCompletionWorkerUnavailable
		},
		Fallback: func(command string, timeout time.Duration) ([]byte, error) {
			if timeout <= 0 {
				t.Fatalf("남은 예산을 넘겨야 한다: %v", timeout)
			}
			return []byte("ok\n"), nil
		},
	}

	out, _, err := RunCompletion(target, "ls -1Ap", false, false)

	if err != nil || out != "ok\n" {
		t.Fatalf("폴백 결과를 줘야 한다: %q %v", out, err)
	}
}

func TestRunCompletionKeepsOutputOverError(t *testing.T) {
	// 완성 명령이 0 이 아닌 코드로 끝나도 찍은 것이 있으면 그것을 준다(best-effort).
	target := CompletionTarget{
		Run: func(string, bool) ([]byte, bool, error) {
			return []byte("partial"), false, errors.New("exit status 1")
		},
	}

	out, _, _ := RunCompletion(target, "git branch", false, false)

	if out != "partial" {
		t.Fatalf("찍은 것을 그대로 줘야 한다: %q", out)
	}
}
