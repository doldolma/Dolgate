package sshconn

import (
	"errors"
	"fmt"
	"net"
	"os"
	"regexp"
	"strings"
	"sync"
	"unicode/utf8"
)

// 배너 표시 상한. 길이를 서버가 정하게 두면 안 된다 — 회사 서버는 /etc/issue.net 으로 수십 줄짜리
// 경고문이나 ASCII 아트를 보내고, 그것이 오류 문구에 그대로 실리면 진짜 원인이 묻힌다.
const (
	maxBannerLines = 12
	maxBannerBytes = 1024
)

var (
	// CSI(\x1b[…) → OSC(\x1b]…) → 나머지 2바이트 이스케이프 순서다. `]`(0x5d)가 마지막 패턴의
	// 범위(0x5c–0x5f)에도 들어가므로 OSC 를 먼저 두지 않으면 여는 두 바이트만 지워지고 본문이 남는다.
	bannerEscapePattern = regexp.MustCompile(`\x1b\[[0-9;:<=>?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]`)
	// 개행(\x0a)과 탭(\x09)만 남긴다. \r 은 지운다 — 남기면 한 줄을 덮어써서 앞부분을 감출 수 있다.
	bannerControlPattern = regexp.MustCompile(`[\x00-\x08\x0b-\x1f\x7f]`)
	// 렌더러의 승인 URL 추출(store/utils/interactive-auth.ts)과 같은 모양으로 둔다.
	bannerURLPattern = regexp.MustCompile(`https?://[^\s<>"')]+`)
)

// bannerCollector 는 서버가 인증 단계에 보내는 배너(RFC 4252 §5.4)를 모은다.
//
// **왜 필요한가:** x/crypto 는 `ClientConfig.BannerCallback` 이 없으면 배너를 조용히 버린다.
// 그런데 어떤 서버는 배너로 사람에게 할 일을 알리고, 그것이 끝날 때까지 인증 응답을 보내지 않는다.
// Tailscale SSH 의 `check` 모드가 그렇다 — "이 URL 로 승인하라" 를 배너로 보내고 기다린다.
// 배너를 버리면 화면에는 아무 이유 없이 멈춘 연결만 남는다(실제로 그 상태를 겪었다).
//
// **내용은 신뢰하지 않는다.** 배너가 오는 시점엔 키 교환·호스트 키 검증이 끝나 있어서 보낸 쪽의
// 신원은 확인됐지만, 텍스트를 그대로 화면이나 터미널에 흘리면 커서 이동·화면 지우기 같은 제어
// 시퀀스가 그대로 먹는다. 그래서 소독하고 상한을 걸어 내보낸다.
type bannerCollector struct {
	mu    sync.Mutex
	parts []string
}

// callback 은 ssh.ClientConfig.BannerCallback 에 그대로 넘긴다.
func (c *bannerCollector) callback(message string) error {
	c.mu.Lock()
	c.parts = append(c.parts, message)
	c.mu.Unlock()
	// 여기서 error 를 돌려주면 인증이 중단된다. 배너는 정보일 뿐이므로 절대 실패로 만들지 않는다.
	return nil
}

func (c *bannerCollector) sanitized() string {
	c.mu.Lock()
	joined := strings.Join(c.parts, "\n")
	c.mu.Unlock()
	return sanitizeBanner(joined)
}

// Text 는 오류 문구에 실어도 되는 배너를 돌려준다. 배너가 없었으면 빈 문자열이다.
func (c *bannerCollector) Text() string {
	return truncateBanner(c.sanitized())
}

// URL 은 배너에 담긴 첫 링크를 돌려준다. **자르기 전** 텍스트에서 찾는다 — 사용자가 눌러야 할
// 링크가 상한 뒤쪽에 있을 수 있고, 그것만은 잃으면 안 된다.
func (c *bannerCollector) URL() string {
	return bannerURLPattern.FindString(c.sanitized())
}

func sanitizeBanner(raw string) string {
	cleaned := bannerEscapePattern.ReplaceAllString(raw, "")
	cleaned = bannerControlPattern.ReplaceAllString(cleaned, "")

	lines := strings.Split(cleaned, "\n")
	for index, line := range lines {
		lines[index] = strings.TrimRight(strings.ReplaceAll(line, "\t", " "), " ")
	}
	// 배너는 보통 빈 줄로 감싸서 온다. 앞뒤 빈 줄을 걷어내면 문구에 붙였을 때 모양이 산다.
	for len(lines) > 0 && lines[0] == "" {
		lines = lines[1:]
	}
	for len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return strings.Join(lines, "\n")
}

func truncateBanner(text string) string {
	if text == "" {
		return ""
	}
	truncated := false

	lines := strings.Split(text, "\n")
	if len(lines) > maxBannerLines {
		lines = lines[:maxBannerLines]
		truncated = true
	}
	text = strings.Join(lines, "\n")

	if len(text) > maxBannerBytes {
		text = text[:maxBannerBytes]
		// 자른 자리가 UTF-8 문자 중간일 수 있다 — 깨진 바이트를 남기지 않는다.
		for len(text) > 0 && !utf8.ValidString(text) {
			text = text[:len(text)-1]
		}
		truncated = true
	}

	if truncated {
		text = strings.TrimRight(text, " \n") + "\n…"
	}
	return text
}

// annotateHandshakeFailure 는 핸드셰이크 실패에 **다음 행동을 할 수 있을 만큼**의 정보를 붙인다.
//
// 두 가지를 더한다:
//
//  1. 멈춘 단계. `ssh.NewClientConn` 은 전송 계층 핸드셰이크(키 교환·호스트 키)와 인증을 한 번에
//     하므로 실패 문구만 보면 어느 쪽인지 알 수 없다. 호스트 키 콜백이 불렸는지가 그 경계다.
//  2. 서버 배너. 단, **URL 이 있거나 정지로 실패했을 때만** 붙인다. 평범한 경고문(MOTD)을 비밀번호
//     오류에까지 붙이면 진짜 원인이 수십 줄 뒤로 밀린다.
//
// 접두사 "ssh handshake failed" 는 호출부가 유지한다 — 데스크톱의 재연결 판정이 그 문구를 보고
// 일시적 오류로 분류한다(renderer/store/utils/reconnect-classify.ts 의 TRANSIENT_ERROR_PATTERNS).
// 뒤에만 덧붙이는 이유가 그것이다.
func annotateHandshakeFailure(err error, banner *bannerCollector, hostKeyChecked bool) error {
	if err == nil {
		return nil
	}

	// 감시가 건 데드라인은 os.ErrDeadlineExceeded 로 올라온다. tsnet 의 사용자 공간 스택처럼
	// 자체 오류 타입을 쓰는 경로도 있어 net.Error 의 Timeout 까지 함께 본다.
	var netErr net.Error
	stalled := errors.Is(err, os.ErrDeadlineExceeded) ||
		(errors.As(err, &netErr) && netErr.Timeout())

	text := ""
	url := ""
	if banner != nil {
		text = banner.Text()
		url = banner.URL()
	}

	var detail strings.Builder
	if stalled {
		if hostKeyChecked {
			detail.WriteString("인증 단계에서 서버 응답이 없습니다")
		} else {
			detail.WriteString("키 교환 단계에서 서버 응답이 없습니다")
		}
	}
	if text != "" && (url != "" || stalled) {
		if detail.Len() > 0 {
			detail.WriteString(". ")
		}
		detail.WriteString("서버가 보낸 안내:\n")
		detail.WriteString(text)
		// 링크가 상한에 잘려 나갔으면 그것만 다시 붙인다.
		if url != "" && !strings.Contains(text, url) {
			detail.WriteString("\n")
			detail.WriteString(url)
		}
	}

	if detail.Len() == 0 {
		return err
	}
	return fmt.Errorf("%w — %s", err, detail.String())
}
