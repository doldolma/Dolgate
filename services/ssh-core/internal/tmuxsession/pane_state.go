package tmuxsession

import (
	"fmt"
	"strings"
	"time"

	"dolssh/services/ssh-core/internal/shellintegration"
	"dolssh/services/ssh-core/internal/sshcmd"

	"golang.org/x/crypto/ssh"
)

// paneStateTimeout 은 pane 상태 조회에 허용하는 시간이다. 셸 통합 설치는 탭 연결 직후
// 한 번 하는 일이고, 이 조회가 늦으면 설치가 미뤄질 뿐이라 짧게 잡는다.
const paneStateTimeout = 3 * time.Second

// paneStateFormat 은 "이 pane 에 지금 타이핑해도 되는가" 를 판정하는 데 필요한 tmux 포맷이다.
//
//   - pane_current_command: pane tty 의 foreground process group 이름. 프롬프트에 있으면
//     셸 이름 자체(bash/zsh/fish)가 오고, vi·htop 이 떠 있으면 그 이름이 온다.
//   - alternate_on: 대체화면(vim·htop·less) 사용 중.
//   - pane_in_mode: tmux 자체 모드(copy mode 등) 중. **불리언이 아니라 활성 모드 개수**다
//     (tmux 는 모드를 큐에 쌓는다) — "1" 만 보면 중첩된 상태를 놓친다.
//   - cursor_x/cursor_y·pane_width/pane_height: 지금 프롬프트가 **그려져 있는지**(cursor_x>0)와,
//     타이핑한 줄의 에코가 어디에 남을지 계산하는 데 쓴다. 분할 직후의 bash 는 아직 프롬프트를
//     안 그렸는데(커서 0,0) 그때 타이핑하면 tty 에코와 readline 재에코가 **둘 다** 화면에 남는다
//     (실기기 %143: `eval …` 이 두 줄). 프롬프트가 있을 때만 바로 심고, 아니면 안착을 기다린다.
//   - pane_current_path: 재연결 직후 상대 경로 자동완성이 사용할 pane 의 현재 디렉터리.
//   - @dolgate_integrated: 우리가 이 pane 에 셸 통합을 심고 **마커까지 확인했다**는 표식. tmux **서버**에
//     사는 pane 옵션이라 detach 를 넘어 살아남는다(실측: tmux 3.0 지원). 재연결에서 이것을
//     보면 다시 심지 않는다 — pane 의 셸은 같은 프로세스라 훅이 그대로 있고, 다시 심으면 그
//     init 의 에코가 화면에 남는다.
//
// 모르는 포맷은 tmux 가 빈 문자열로 확장하므로(에러가 아니다) 구버전에서도 "판정 불가" 로
// 떨어져 안전한 쪽(주입하지 않음)으로 간다.
func paneStateFormat(integratedOption string) string {
	return "#{pane_current_command}\t#{alternate_on}\t#{pane_in_mode}\t#{" + integratedOption + "}" +
		"\t#{cursor_x}\t#{cursor_y}\t#{pane_width}\t#{pane_height}\t#{pane_current_path}"
}

// paneIntegratedOptionBase 는 표식 옵션의 기본 이름이다.
const paneIntegratedOptionBase = "@dolgate_integrated"

// paneIntegratedOption 은 표식을 **어느 범위에 어떤 이름으로** 둘지 정한다.
//
// pane 옵션(set-option -p)은 tmux 3.0 이 들여왔다. 그 아래(2.x)에서는 표식을 남길 데가 없어
// 재연결마다 이미 훅이 살아 있는 셸에 다시 심었고, 그 주입 명령의 에코가 화면에 남았다
// (실기 2.5 재현: `eval "$(tmux show-buffer -b 'dolgate-init-0')"; …` 가 프롬프트에 그대로).
// 핸드셰이크 필터가 그 에코를 가리지만 1.5초 뒤 flush 하므로, 지연이 있는 원격에서는 새어 나온다.
//
// 2.5 에서도 **세션 옵션**은 되고 포맷으로도 읽힌다(실측: `set-option -t %N @k v` 뒤
// `display-message -p -t %N '#{@k}'` 가 값을 돌려준다). 세션 옵션은 pane 마다 나뉘지 않으므로
// pane 번호를 이름에 넣어 구분한다. pane id 는 서버 안에서 재사용되지 않아 충돌하지 않는다.
//
// 3.0 이상은 지금까지 쓰던 pane 옵션 그대로다 — 신버전 동작을 바꾸지 않는다.
// 버전 미상이면 atLeast 가 true(최신 가정)라 pane 옵션 쪽으로 간다.
func paneIntegratedOption(paneID string, ver tmuxVersion) (scope, name string) {
	if ver.atLeast(3, 0) {
		return "-p", paneIntegratedOptionBase
	}
	return "", paneIntegratedOptionBase + "_" + strings.TrimPrefix(paneID, "%")
}

// paneState 는 tmux 서버가 알려준 pane 의 현재 상태다.
type paneState struct {
	command     string
	alternateOn bool
	inMode      bool
	// integrated 는 이 pane 에 이미 셸 통합을 심었다는 뜻이다(tmux 서버의 pane 옵션).
	integrated bool
	// 커서와 pane 크기(모르면 0). 프롬프트가 그려졌는지와 에코 자리 계산에 쓴다.
	cursorX, cursorY int
	width, height    int
	cwd              string
	// known 은 tmux 가 실제로 답했는지다(조회 실패·형식 불일치면 false).
	known bool
}

// shellAtPrompt 는 지금 pane 앞에 있는 것이 "타이핑해도 되는 셸" 이면 그 이름을, 아니면 빈
// 문자열을 돌려준다.
//
// 빈 문자열의 뜻은 하나로 묶인다: **지금 이 pane 에 써 넣지 마라.** vi 가 떠 있어서든,
// copy mode 여서든, tmux 가 답을 안 줘서든 결론은 같다.
func (s paneState) shellAtPrompt() string {
	if !s.known || s.alternateOn || s.inMode || !s.promptDrawn() {
		return ""
	}
	return shellintegration.NormalizeRemoteShell(s.command)
}

// queryPaneState 는 pane 앞에 무엇이 있는지 tmux 서버에 묻는다.
//
// control 채널이 아니라 **보조 exec 채널**로 묻는다. control mode 의 명령 응답
// (%begin~%end 사이)은 이스케이프되지 않은 원문이라, 답에 '%' 로 시작하는 줄이 섞이면
// 파서가 그것을 notification 으로 먹는다. 게다가 지금 %begin 수집은 list-windows 전용
// 단일 상태라 응답을 명령과 짝지을 수단도 없다.
func queryPaneState(client *ssh.Client, paneID string, ver tmuxVersion) paneState {
	if client == nil || !isPaneID(paneID) {
		return paneState{}
	}
	_, option := paneIntegratedOption(paneID, ver)
	command := fmt.Sprintf(
		"command -v tmux >/dev/null 2>&1 && tmux display-message -p -t '%s' '%s'",
		paneID, paneStateFormat(option),
	)
	stdout, _, err := sshcmd.RunWithTimeout(client, command, paneStateTimeout)
	if err != nil {
		return paneState{}
	}
	return parsePaneState(stdout)
}

// parsePaneState 는 display-message 한 줄을 paneState 로 만든다.
func parsePaneState(stdout []byte) paneState {
	line := stdout
	if i := strings.IndexAny(string(line), "\r\n"); i >= 0 {
		line = line[:i]
	}
	fields := strings.Split(string(line), "\t")
	if len(fields) < 8 {
		return paneState{}
	}
	state := paneState{
		command:     strings.TrimSpace(fields[0]),
		alternateOn: paneFlagSet(fields[1]),
		inMode:      paneFlagSet(fields[2]),
		integrated:  strings.TrimSpace(fields[3]) == paneIntegratedMarker,
		cursorX:     paneFlagInt(fields[4]),
		cursorY:     paneFlagInt(fields[5]),
		width:       paneFlagInt(fields[6]),
		height:      paneFlagInt(fields[7]),
		known:       true,
	}
	if len(fields) > 8 {
		state.cwd = strings.Join(fields[8:], "\t")
	}
	return state
}

// promptDrawn 은 셸이 프롬프트를 그려 놓고 기다리는 중인지다. 분할·새 창 직후의 bash 는 아직
// 프롬프트를 안 그렸고(커서 0,0), 그때 타이핑하면 에코가 두 번 남는다. 프롬프트가 비어 있는
// 셸(PS1="")은 여기서 걸러지지만, 그 pane 은 안착 게이트가 첫 출력에 반응해 심는다.
func (s paneState) promptDrawn() bool {
	return s.known && s.cursorX > 0
}

// paneIntegratedMarker 는 @dolgate_integrated 에 남기는 값이다. **버전이다** — 1 이 아니다.
//
// 처음에는 1 을 썼고, 그것을 init 이 실제로 깔렸는지 확인하지 않고 타이핑 직후에 남겼다. 그래서
// init 이 깨진 pane(예전 CR 버그)에도 1 이 남아 재연결마다 "이미 심어짐" 으로 건너뛰었다 —
// 자동완성이 영영 안 되는 pane 이 그렇게 생겼다. 지금은 OSC 133;A 마커가 실제로 도착했을 때만
// 이 값을 남기고, 다른 값(옛 1 포함)은 심어지지 않은 것으로 본다. 심는 방식이 또 바뀌면 값을
// 올려서 옛 설치를 한 번 다시 심게 한다.
const paneIntegratedMarker = "2"

// paneFlagSet 은 tmux 플래그 값이 "켜짐" 인지 본다. alternate_on 은 "0"/"1" 이지만
// pane_in_mode 는 개수라서 "2" 도 올 수 있다 — 0 과 빈 값만 꺼짐으로 본다.
func paneFlagSet(value string) bool {
	trimmed := strings.TrimSpace(value)
	return trimmed != "" && trimmed != "0"
}

// isPaneID 는 tmux pane id("%12") 모양만 통과시킨다. 이 값은 셸 명령의 인용부호 안으로
// 들어가므로, tmux 가 준 모양이 아닌 것은 조회하지 않는다.
func isPaneID(paneID string) bool {
	if len(paneID) < 2 || paneID[0] != '%' {
		return false
	}
	for i := 1; i < len(paneID); i++ {
		if paneID[i] < '0' || paneID[i] > '9' {
			return false
		}
	}
	return true
}
