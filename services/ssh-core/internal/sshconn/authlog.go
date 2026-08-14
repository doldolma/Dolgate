package sshconn

import (
	"fmt"
	"log"
	"os"
	"strings"
)

// authLogQuiet 은 이 진단을 끈다(DOLGATE_AUTH_LOG=0). 프로세스 시작 시 1회 평가.
var authLogQuiet = os.Getenv("DOLGATE_AUTH_LOG") == "0"

// AuthLogf 는 대화형 인증의 진행을 stderr 로 남긴다.
//
// **왜 stderr 인가:** stdout 은 프레임 프로토콜 채널이라 한 글자라도 쓰면 통신이 깨진다. 데스크톱은
// 코어의 stderr 를 `[ssh-core] …` 로 개발자 콘솔에 붙여 주므로, 여기 남는 줄이 곧 지원용 기록이 된다.
//
// **왜 기본으로 켜 두는가:** 이 구간의 실패는 재현이 사람 손에 달려 있어서(OTP 코드, 브라우저 승인)
// "플래그 켜고 다시 해 보세요" 가 왕복 한 번을 그대로 낭비한다. 줄 수는 연결당 몇 줄뿐이다.
//
// **비밀값은 남기지 않는다.** 프롬프트 라벨(서버가 쓴 글), 홉, 라운드 번호, 그 라운드를 어떻게
// 처리했는지만 남긴다. 답의 길이도 남기지 않는다 — 비밀번호 길이는 그 자체로 단서다.
func AuthLogf(format string, args ...any) {
	if authLogQuiet {
		return
	}
	log.Printf("auth: "+format, args...)
}

// describeHop 은 로그에 쓸 홉 이름이다. 비어 있으면 홉을 모르는 호출이다(단일 홉 테스트 등).
func describeHop(hop InteractiveHop) string {
	if strings.TrimSpace(hop.Host) == "" {
		return "target"
	}
	if hop.Username == "" {
		return fmt.Sprintf("%s:%d", hop.Host, hop.Port)
	}
	return fmt.Sprintf("%s@%s:%d", hop.Username, hop.Host, hop.Port)
}

// describePrompts 는 라벨만 골라 적는다. 값이 아니라 "무엇을 물었는지" 가 진단에 필요하다.
func describePrompts(questions []string) string {
	labels := make([]string, 0, len(questions))
	for _, question := range questions {
		labels = append(labels, fmt.Sprintf("%q", strings.TrimSpace(question)))
	}
	return "[" + strings.Join(labels, " ") + "]"
}
