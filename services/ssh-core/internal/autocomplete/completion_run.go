package autocomplete

import (
	"errors"
	"time"

	"golang.org/x/crypto/ssh"

	"dolssh/services/ssh-core/internal/sshcmd"
)

// CompletionTarget 은 보조 명령을 돌릴 **재료**다 — 핸들 종류가 아니라.
//
// 세션 매니저마다 자기 핸들 타입이 있어서(SSH 세션 · tmux control 연결) 예전에는 실행 경로를
// 각자 썼다. 예산·워커·폴백·상한이 두 벌이 됐고, 그러다 sudo 되물리기가 **한쪽에만** 들어가
// 같은 세션 패널이 SSH 탭에서는 도커를 읽고 tmux 탭에서는 못 읽었다. 재료만 받으면 그 경로가
// 한 번만 존재한다.
//
// 로컬 세션은 여기 오지 않는다 — SSH client 도 워커 풀도 없이 서브프로세스로 도는 다른 물건이고,
// 되물릴 자격증명 자체가 없다.
type CompletionTarget struct {
	// Run 은 이 연결의 보조 채널에서 명령을 돌린다.
	Run func(command string, background bool) ([]byte, bool, error)
	// Fallback 은 워커 채널 자체를 못 열었을 때 쓰는 경로(exec 채널 하나를 그냥 연다).
	// nil 이면 폴백 없이 그 오류를 그대로 돌려준다.
	Fallback func(command string, timeout time.Duration) ([]byte, error)
	// SudoPassword 는 지금 되물릴 수 있는 비밀번호를 준다. nil 이거나 빈 값을 주면 이 연결은
	// 승격을 지원하지 않는다(키·에이전트로 붙었거나 이미 한 번 거절당했다).
	SudoPassword func() string
	// DenySudo 는 되물린 비밀번호가 거절됐을 때 불린다. 이 연결에서 다시 내밀지 않게 한다 —
	// 틀린 sudo 시도를 반복하면 pam_faillock 이 계정을 잠근다.
	DenySudo func()
}

// PoolTarget 은 보조 채널 풀과 client 를 가진 연결(SSH 세션 · tmux control 연결)의 재료를 만든다.
func PoolTarget(
	pool *sshcmd.WorkerPool,
	client *ssh.Client,
	sudoPassword func() string,
	denySudo func(),
) CompletionTarget {
	return CompletionTarget{
		Run: func(command string, background bool) ([]byte, bool, error) {
			lane := sshcmd.LaneInteractive
			if background {
				lane = sshcmd.LaneBackground
			}
			return pool.Run(lane, command, CompletionTimeoutFor(background), MaxCompletionBytes)
		},
		Fallback: func(command string, timeout time.Duration) ([]byte, error) {
			stdout, _, err := sshcmd.RunWithTimeout(client, command, timeout)
			return stdout, err
		},
		SudoPassword: sudoPassword,
		DenySudo:     denySudo,
	}
}

// RunCompletion 은 짧은 read-only 명령을 보조 채널에서 돌린다.
//
// background 는 사람이 결과를 기다리지 않는 폴링이라는 뜻이다(세션 패널의 도커·지표). 그런
// 질의는 두 번째 레인에서 돌아 사용자가 치는 자동완성 뒤에 줄 서지 않는다.
//
// elevate 는 이 명령을 `sudo -S` 로 감싸고 접속에 쓴 비밀번호를 되물려 달라는 뜻이다. 소켓
// 권한이 없고 `sudo -n` 도 막힌 호스트의 도커가 그렇게만 읽힌다.
func RunCompletion(
	target CompletionTarget,
	command string,
	background, elevate bool,
) (string, bool, error) {
	if target.Run == nil {
		return "", false, errors.New("completion target is not connected")
	}
	// 예산은 이 함수 전체에 하나다 — 아래 폴백까지 합쳐서 이 시간을 넘지 않는다. 단계마다 새
	// 예산을 주면 합이 호출자(데스크톱)의 요청 타임아웃을 넘겨, 코어가 답을 못 보내게 된다.
	budget := CompletionTimeoutFor(background)
	startedAt := time.Now()

	if elevate {
		// 되물릴 비밀번호가 없거나 이미 한 번 거절당했으면 **원격을 건드리지 않는다.**
		password := ""
		if target.SudoPassword != nil {
			password = target.SudoPassword()
		}
		if password == "" {
			return "", false, sshcmd.ErrSudoPasswordUnavailable
		}
		invocation, buildErr := sshcmd.BuildSudoCommand(command, password)
		if buildErr != nil {
			return "", false, buildErr
		}
		out, trunc, runErr := target.Run(invocation.Script, background)
		if runErr != nil {
			// 왕복 자체가 실패했다(차례를 못 얻었거나 시간이 초과됐다) — sudo 가 통했는지는
			// 알 수 없다. 여기서 거절로 단정하면 멀쩡한 호스트를 영영 막는다.
			return "", trunc, runErr
		}
		stripped, ok := sshcmd.StripSudoMarker(out, invocation.OKMarker)
		if !ok {
			// 표식이 없다 = sudo 가 명령을 시작하지도 못했다 = 비밀번호가 거절됐다.
			//
			// **출력이 비었다는 것만으로는 판정하지 않는다.** 컨테이너가 하나도 없는 호스트의
			// `docker ps -a` 도 정상적으로 아무것도 찍지 않는다.
			if target.DenySudo != nil {
				target.DenySudo()
			}
			return "", false, sshcmd.ErrSudoRefused
		}
		return string(stripped), trunc, nil
	}

	stdout, truncated, err := target.Run(command, background)
	if err == nil || len(stdout) > 0 {
		return string(stdout), truncated, err
	}
	if !errors.Is(err, sshcmd.ErrCompletionWorkerUnavailable) || target.Fallback == nil {
		return "", false, err
	}

	remaining := budget - time.Since(startedAt)
	if remaining <= 0 {
		return "", false, err
	}
	fallbackStdout, fallbackErr := target.Fallback(command, remaining)
	// 완성 명령이 0 이 아닌 코드로 끝나는 것은 치명적이지 않다 — 찍은 것이 있으면 그것을 준다.
	// 아무것도 못 받았을 때만 오류로 올린다.
	if fallbackErr != nil && len(fallbackStdout) == 0 {
		return "", false, fallbackErr
	}
	out, truncated := CapOutput(fallbackStdout)
	return out, truncated, nil
}
