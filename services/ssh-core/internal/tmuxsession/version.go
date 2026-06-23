package tmuxsession

import (
	"log"
	"os"
	"strconv"
	"strings"
)

// tmuxDebug 은 DOLGATE_TMUX_DEBUG 환경변수가 설정돼 있으면 control mode 진단 로그를
// 켠다(기본 off — 정상 운영 시 조용). 프로세스 시작 시 1회 평가.
var tmuxDebug = os.Getenv("DOLGATE_TMUX_DEBUG") != ""

// debugTmux 은 진단 로그를 표준 log 로 남긴다(off 면 no-op).
func debugTmux(format string, args ...any) {
	if !tmuxDebug {
		return
	}
	log.Printf(format, args...)
}

// tmuxVersion 은 파싱된 tmux 버전(major.minor)이다. 문자 suffix(예 "3.0a")는 무시한다.
// known=false 면 버전 미상(감지 실패)으로, 호출부는 안전 기본(최신 가정)으로 처리한다.
type tmuxVersion struct {
	major int
	minor int
	patch int // letter suffix 순위: "a"=1, "b"=2 … 없으면 0. 3.0 vs 3.0a 구분용.
	known bool
}

// parseTmuxVersion 은 "3.0a", "2.6", "tmux 2.6", "3.5a" 같은 문자열에서 major/minor 를
// 뽑는다. letter suffix 와 그 외 비숫자는 무시한다. 빈 문자열/파싱 불가면 known=false.
func parseTmuxVersion(s string) tmuxVersion {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "tmux ")
	s = strings.TrimSpace(s)
	if s == "" {
		return tmuxVersion{}
	}
	// major: 선두 숫자.
	i := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	if i == 0 {
		return tmuxVersion{}
	}
	major, err := strconv.Atoi(s[:i])
	if err != nil {
		return tmuxVersion{}
	}
	v := tmuxVersion{major: major, known: true}
	// minor: '.' 뒤 숫자(있을 때만). 'a' 같은 letter suffix 에서 멈춘다.
	if i < len(s) && s[i] == '.' {
		j := i + 1
		for j < len(s) && s[j] >= '0' && s[j] <= '9' {
			j++
		}
		if j > i+1 {
			minor, err := strconv.Atoi(s[i+1 : j])
			if err == nil {
				v.minor = minor
			}
		}
		i = j
	}
	// patch: 버전 뒤 소문자 1글자(예 "3.0a"→1, "3.5a"→1). 3.0 과 3.0a 를 구분한다.
	if i < len(s) && s[i] >= 'a' && s[i] <= 'z' {
		v.patch = int(s[i]-'a') + 1
	}
	return v
}

// atLeast 는 버전이 maj.min 이상인지 본다. 버전 미상(known=false)이면 true 를 반환해
// 최신 가정(현행 control mode 경로)으로 동작한다.
func (v tmuxVersion) atLeast(maj, min int) bool {
	if !v.known {
		return true
	}
	if v.major != maj {
		return v.major > maj
	}
	return v.minor >= min
}

// 검증된 임계값(Phase1, git 커밋 교차검증):
//   - send-keys -H(hex): tmux 3.0a 도입(커밋 fc2016db; 3.0 릴리스엔 없음, 3.0a 가 첫 포함).
//     사용자 실측(2.6 에러, 3.0a 정상)과 일치. patch suffix 로 3.0a 와 3.0 을 구분해 정확히
//     3.0a 이상에서만 -H 를 쓴다(3.0a/3.5a 는 기존 -H 경로 유지 = 무회귀, 평이한 3.0 은 레거시).
//   - refresh-client -C 인자: 콤마 "W,H" 가 원래(모든 버전) 형식이고 WxH 는 2.9 에서 추가됐다.
//     콤마는 2.6~최신 전부 동작하므로 콤마를 항상 쓴다(refreshClientCommand 참고) — 분기 불필요.

// supportsSendKeysHex 는 send-keys -H 를 쓸 수 있는지(>= 3.0a) 본다.
func (v tmuxVersion) supportsSendKeysHex() bool {
	if !v.known {
		return true // 미상 → 최신 가정
	}
	if v.major != 3 {
		return v.major > 3
	}
	if v.minor != 0 {
		return true // 3.1 이상
	}
	return v.patch >= 1 // 3.0a 이상(평이한 3.0 은 false)
}
