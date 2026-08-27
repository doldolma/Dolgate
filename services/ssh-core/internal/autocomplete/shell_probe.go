package autocomplete

import (
	"bytes"
	"strings"
	"sync"
)

// 서브셸에 "너 누구냐" 고 묻는 한 줄.
//
// 왜 묻나. 예전에는 셸을 모르면 bash·zsh 겸용 스크립트를 보냈는데, 그것이 여러 줄이라 POSIX
// 셸(dash·busybox)에서 PS2 계속 프롬프트가 화면에 남았다(도커 컨테이너에서 스크립트 전문이
// 그대로 찍힌 그 증상). 한 덩어리로 보내면 dash 가 PS2 를 뱉고, 나눠 보내면 bash 가 첫 줄에서
// 훅을 깔며 마커를 보내 핸드셰이크를 끝내 버려 둘째 줄 echo 가 남는다 — 줄 모양으로는 못 푼다.
//
// 그래서 순서를 바꾼다. 먼저 짧은 한 줄로 셸을 확인하고, **그 셸 전용 한 줄만** 보낸다.
// 지원하지 않는 셸이면 아무것도 보내지 않는다.

const (
	// 답이 돌아오는 OSC. 화면에 글자로 남지 않고, 핸드셰이크가 이 시퀀스를 앵커로 삼는다.
	ShellProbeReplyPrefix = "\033]1337;dg-shell="
	shellProbeReplyEnd    = "\a"
)

// ShellProbeCommand 는 셸에 써 넣을 한 줄이다.
//
// 조건이 까다롭다: bash·zsh·dash·busybox ash·fish 에서 **모두 문법적으로 유효**해야 하고,
// 한 줄이어야 하며(PS2 를 만들지 않으려고), 답이 화면 글자가 아니어야 한다. `printf` 의 8진
// 이스케이프는 POSIX 규격이라 위 셸에서 모두 동작한다(실측).
//
// 앞의 공백은 HISTCONTROL=ignorespace 용이고, 뒤 꼬리는 bash 히스토리에서 이 줄을 지운다.
func ShellProbeCommand() string {
	return " printf '\\033]1337;dg-shell=%s|%s|%s|%s\\007'" +
		` "$BASH_VERSION" "$ZSH_VERSION" "$FISH_VERSION" ""` +
		probeHistoryCleanupTail + "\r"
}

// probeHistoryCleanupTail 은 bash 에서만 이 줄을 히스토리에서 지운다.
//
// 왜 평소의 bashHistoryCleanupTail 을 못 쓰나: 거기에 있는 `$((HISTCMD-1))` 를 **fish 가 명령
// 치환으로 읽고 파싱 단계에서 죽는다.** 그러면 fish 는 프로브에 답하지 못하고, 답이 없으니 통합도
// 안 붙는다(실측: "command substitutions not allowed in command position").
//
// 그래서 산술 확장을 작은따옴표 안에 숨겨 eval 에 넘긴다. fish 는 그 문자열을 통째로 인용문으로
// 읽고 넘어가며, `[ -n "$BASH_VERSION" ]` 가 거짓이라 실행되지도 않는다. dash·zsh 도 같은 이유로
// 조용하고, bash 에서만 실제로 지워진다.
const probeHistoryCleanupTail = `; [ -n "$BASH_VERSION" ] && eval 'history -d $((HISTCMD-1))' >/dev/null 2>&1`

// PowerShellProbeCommand 는 같은 질문의 PowerShell 판이다.
//
// POSIX 판을 PowerShell 에 보내면 `printf` 를 못 찾아 오류 한 줄이 화면에 남는다. 어느 판을 보낼지는
// **우리가 띄운 프로세스 이름**으로 고른다(러너의 ShellKind) — 사용자가 친 명령을 파싱하지 않는다.
func PowerShellProbeCommand() string {
	return ` Write-Host -NoNewline ([char]27 + "]1337;dg-shell=|||" + ` +
		`$PSVersionTable.PSVersion.ToString() + [char]7)` + "\r"
}

// ParseShellProbeReply 는 출력에서 답을 찾는다.
//
// shell 은 우리가 통합을 넣을 수 있는 셸 이름이거나, 지원 대상이 아니면 빈 문자열이다.
// end 는 답 시퀀스가 끝나는 위치(그 뒤부터가 진짜 출력) 다.
func ParseShellProbeReply(data []byte) (shell string, end int, ok bool) {
	start := bytes.Index(data, []byte(ShellProbeReplyPrefix))
	if start < 0 {
		return "", 0, false
	}
	body := data[start+len(ShellProbeReplyPrefix):]
	stop := bytes.Index(body, []byte(shellProbeReplyEnd))
	if stop < 0 {
		// 아직 다 도착하지 않았다. 다음 청크에서 다시 본다.
		return "", 0, false
	}
	fields := strings.Split(string(body[:stop]), "|")
	return shellFromProbeFields(fields), start + len(ShellProbeReplyPrefix) + stop + len(shellProbeReplyEnd), true
}

// shellFromProbeFields 는 bash|zsh|fish 버전 문자열에서 셸을 고른다.
//
// 버전 문자열을 그대로 실어 오는 이유: 이름을 셸이 스스로 말하게 하려면 분기가 필요한데,
// 그 분기 문법이 셸마다 다르다(fish 는 `${VAR:+…}` 를 모른다). 비어 있는지 아닌지만 보면
// 어느 셸에서도 같은 한 줄로 끝난다.
func shellFromProbeFields(fields []string) string {
	value := func(index int) string {
		if index < len(fields) {
			return strings.TrimSpace(fields[index])
		}
		return ""
	}
	switch {
	case value(0) != "":
		return "bash"
	case value(1) != "":
		return "zsh"
	case value(2) != "":
		return "fish"
	case value(3) != "":
		return "pwsh"
	default:
		// dash·busybox·ksh… 통합을 넣을 수 없는 셸이다.
		return ""
	}
}

// 셸 프로브의 답을 기다리는 곳.
//
// 답은 OSC 라 청크 경계에서 잘릴 수 있어 꼬리를 조금 들고 있는다. 한 번 답을 받으면 스스로
// 무장을 푼다 — 늦게 온 같은 시퀀스로 두 번 주입하지 않기 위해서다.
type ShellProbe struct {
	mu       sync.Mutex
	armed    bool
	buffer   []byte
	onResult func(shell string)
}

// 답을 찾기 위해 들고 있는 최대 꼬리. 답 시퀀스는 100바이트 남짓이라 넉넉하다.
const shellProbeBufferLimit = 4096

func (w *ShellProbe) Arm(onResult func(shell string)) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.armed = true
	w.buffer = nil
	w.onResult = onResult
}

func (w *ShellProbe) Disarm() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.armed = false
	w.buffer = nil
	w.onResult = nil
}

// Observe 는 raw 출력에서 답을 찾는다. 핸드셰이크 필터 **전에** 불러야 원본을 본다.
func (w *ShellProbe) Observe(chunk []byte) {
	w.mu.Lock()
	if !w.armed {
		w.mu.Unlock()
		return
	}
	w.buffer = append(w.buffer, chunk...)
	if len(w.buffer) > shellProbeBufferLimit {
		w.buffer = w.buffer[len(w.buffer)-shellProbeBufferLimit:]
	}
	shell, _, ok := ParseShellProbeReply(w.buffer)
	if !ok {
		w.mu.Unlock()
		return
	}
	onResult := w.onResult
	w.armed = false
	w.buffer = nil
	w.onResult = nil
	w.mu.Unlock()
	if onResult != nil {
		// 읽기 루프를 붙들지 않는다 — 주입은 다시 이 루프의 출력을 기다린다.
		go onResult(shell)
	}
}

// CommandFinishedMarker 는 "지금 실행 중이던 명령을 끝난 것으로 쳐라" 는 신호다.
//
// 통합이 없는 셸(busybox·dash)로 들어가면 바깥 셸이 보낸 133;C 만 남고 133;D 는 그 셸을 빠져나올
// 때까지 오지 않는다. 그동안 화면의 모든 입력·출력이 **하나의 실행 중 명령 블록**에 빨려 들어가,
// 상태 점이 계속 도는 것처럼 보인다.
//
// 프로브가 "이 셸에는 통합을 넣을 수 없다" 고 답한 순간이 그것을 알 수 있는 정확한 시점이다.
// 그때 이 마커를 흘려 블록을 닫는다. 종료 코드는 모르므로 싣지 않는다 — 나중에 그 셸을 빠져나올
// 때 오는 진짜 D 는 닫을 블록이 없어 무시된다.
const CommandFinishedMarker = "\033]133;D\007"
