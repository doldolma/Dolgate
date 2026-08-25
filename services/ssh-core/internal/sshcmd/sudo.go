package sshcmd

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

// ErrSudoPasswordUnavailable 는 이 세션에 되물릴 비밀번호가 없다는 뜻이다(키·에이전트로
// 붙었거나, 이미 한 번 틀려서 다시 시도하지 않기로 한 경우).
var ErrSudoPasswordUnavailable = errors.New("sudo password unavailable")

// ErrSudoRefused 는 sudo 가 명령을 **시작조차 하지 않았다**는 뜻이다 — 되물린 비밀번호가
// 거절됐다. 호출자는 이 세션에서 다시 내밀지 말아야 한다(pam_faillock 이 계정을 잠근다).
var ErrSudoRefused = errors.New("sudo refused the replayed password")

// SudoInvocation 은 sudo 로 감싼 스크립트와, 그 sudo 가 실제로 통했는지 가리는 표식이다.
type SudoInvocation struct {
	Script string
	// OKMarker 는 sudo 가 명령을 시작했을 때만 stdout 맨 앞에 찍힌다.
	//
	// **"출력이 비었다" 로는 가릴 수 없기 때문이다.** 컨테이너가 하나도 없는 호스트의
	// `docker ps -a` 도 정상적으로 아무것도 찍지 않는다 — 그것을 거절로 읽으면 멀쩡한 호스트의
	// sudo 를 영영 막아 버린다(그리고 화면은 "다시 받는 중" 에서 못 빠져나온다).
	OKMarker string
}

// BuildSudoCommand 는 명령을 `sudo -S` 로 감싸고 비밀번호를 **stdin 으로** 흘린다.
//
// 왜 인자가 아니라 stdin 인가: 명령줄에 비밀번호를 넣으면 원격의 프로세스 목록(`ps`)과 감사
// 로그에 그대로 남는다. 히어독으로 넘기면 우리 exec 채널의 데이터일 뿐이라 어디에도 인자로
// 찍히지 않는다. 구분자에는 난수를 넣어 비밀번호에 어떤 문자가 들어와도 끝을 오인하지 않게 한다.
//
// -p 에 빈 문자열을 주는 것은 프롬프트를 지우기 위해서다 — 지우지 않으면
// "[sudo] password for …" 가 stdout 에 섞여 파서가 그것을 결과의 첫 줄로 읽는다.
func BuildSudoCommand(command, password string) (SudoInvocation, error) {
	if password == "" {
		return SudoInvocation{}, ErrSudoPasswordUnavailable
	}
	random := make([]byte, 12)
	if _, err := rand.Read(random); err != nil {
		return SudoInvocation{}, err
	}
	nonce := hex.EncodeToString(random)
	heredoc := "__DOLGATE_SUDO_" + nonce + "__"
	okMarker := "__DOLGATE_SUDO_OK_" + nonce + "__"
	// 비밀번호에 줄바꿈이 있으면 sudo 는 첫 줄만 읽는다 — 여기서 잘라 뒷줄이 명령으로
	// 흘러 들어가지 않게 한다.
	line := password
	if index := strings.IndexAny(line, "\r\n"); index >= 0 {
		line = line[:index]
	}
	// 표식을 **명령보다 먼저** 찍는다. 비밀번호가 거절되면 sudo 는 sh 를 띄우지도 않으므로
	// 표식이 아예 오지 않는다.
	inner := "printf %s " + QuotePosix(okMarker) + "; " + command
	return SudoInvocation{
		Script: fmt.Sprintf(
			"sudo -S -p '' sh -c %s <<'%s'\n%s\n%s",
			QuotePosix(inner),
			heredoc,
			line,
			heredoc,
		),
		OKMarker: okMarker,
	}, nil
}

// StripSudoMarker 는 표식을 걷어내고 원래 출력을 돌려준다. 표식이 없으면 sudo 가 명령을
// 시작하지 못한 것이다(ok=false).
func StripSudoMarker(output []byte, marker string) ([]byte, bool) {
	if !bytes.HasPrefix(output, []byte(marker)) {
		return nil, false
	}
	return output[len(marker):], true
}
