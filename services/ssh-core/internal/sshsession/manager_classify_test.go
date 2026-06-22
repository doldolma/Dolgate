package sshsession

import (
	"errors"
	"fmt"
	"io"
	"testing"

	"golang.org/x/crypto/ssh"
)

// classifyWaitError가 "셸이 스스로 종료"와 "비정상 단절"을 올바르게 가르는지 검증한다.
// reboot은 ExitMissingError / io.EOF / 시그널 종료 중 하나로 표면화되며, 모두 transport로
// 분류돼야 자동 재연결 머신이 탭을 살려 둔다. 반대로 exit / exit N(시그널 없는 종료)은
// remote-exit로 분류돼 탭이 닫혀야 한다.
func TestClassifyWaitError(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want string
	}{
		{
			name: "nil → 정상 종료(exit 0)",
			err:  nil,
			want: closeReasonRemoteExit,
		},
		{
			// status는 unexported라 설정 불가하지만 zero ExitError는 Signal()=="" 라서
			// "시그널 없는 종료(exit / exit N)" 분기를 그대로 검증한다.
			name: "ExitError(시그널 없음) → 사용자 셸 종료",
			err:  &ssh.ExitError{},
			want: closeReasonRemoteExit,
		},
		{
			name: "ExitMissingError → 상태 없이 채널 닫힘(reboot/네트워크)",
			err:  &ssh.ExitMissingError{},
			want: closeReasonTransport,
		},
		{
			name: "io.EOF → 전송 단절(이전엔 remote-exit로 새던 케이스)",
			err:  io.EOF,
			want: closeReasonTransport,
		},
		{
			name: "일반 I/O 에러 → 전송 단절",
			err:  errors.New("read: connection reset by peer"),
			want: closeReasonTransport,
		},
		{
			// errors.As가 래핑된 ExitError까지 풀어 보는지 검증(타입 단언 대신 errors.As 사용 근거).
			name: "wrapped ExitError(시그널 없음) → remote-exit",
			err:  fmt.Errorf("session ended: %w", &ssh.ExitError{}),
			want: closeReasonRemoteExit,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := classifyWaitError(tc.err); got != tc.want {
				t.Fatalf("classifyWaitError(%v) = %q, want %q", tc.err, got, tc.want)
			}
		})
	}
}
