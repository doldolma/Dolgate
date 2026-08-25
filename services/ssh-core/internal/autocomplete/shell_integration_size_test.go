package autocomplete

import (
	"strings"
	"testing"
)

// 셸을 모른 채 무장했을 때 기본으로 지우는 첫 echo(=bash 용). 기존 테스트들이 "주입 echo" 하나를
// 놓고 검사하므로 그 대표값으로 쓴다.
var injectedCommandEcho = injectedCommandEchoes[0]

// 주입 명령 하나는 MAX_CANON(1024)을 넘어서는 안 된다.
//
// 넘으면 줄 편집기가 없는 동안(셸 기동 중, dash·busybox 처럼 줄 편집기가 아예 없는 셸) tty 가
// 한 줄을 그 크기에서 잘라 버린다 — 끝의 CR 까지 잘려 명령이 실행되지 않고 원문만 화면에 남는다.
// 실제로 그렇게 깨졌다: bash·zsh 를 한 줄에 담아 1213바이트가 되면서 로컬 터미널과 dash 서브셸이
// 같이 죽었다. 이 테스트가 그때 있었다면 커밋이 여기서 걸렸다.
func TestInjectedLinesStayUnderTheCanonicalLineLimit(t *testing.T) {
	// PowerShell 은 제외한다. POSIX tty 의 canonical 모드를 지나지 않는다 — Windows 로컬은
	// 기동 인자(-EncodedCommand)로 넣고, 그 밖의 경로는 PSReadLine 이 raw 모드로 읽는다.
	for _, shell := range []string{"", "bash", "zsh", "fish"} {
		label := shell
		if label == "" {
			label = "unknown"
		}
		lines := ShellIntegrationInitLines(shell)
		if len(lines) == 0 {
			t.Fatalf("%s: 주입할 줄이 없다", label)
		}
		for index, command := range lines {
			if len(command) > MaxShellIntegrationCommandBytes {
				t.Errorf(
					"%s[%d]: %d바이트 — 상한 %d 초과",
					label, index, len(command), MaxShellIntegrationCommandBytes,
				)
			}
		}
	}
}

// 셸을 알면 하나, 모르면 둘. 모른다고 주입을 포기하면 서브셸 통합이 조용히 사라진다.
func TestInjectedLineCountFollowsWhatWeKnow(t *testing.T) {
	for shell, want := range map[string]int{
		"":           3, // 모름 → `{ bash…` / `zsh…` / `}` 세 줄이 한 명령
		"bash":       1,
		"/bin/zsh":   1,
		"fish":       1,
		"pwsh":       1,
		"powershell": 1,
		"ksh":        0, // 지원하지 않는 셸 → 주입하지 않는다
		"cmd":        0,
	} {
		if got := len(ShellIntegrationInitLines(shell)); got != want {
			t.Errorf("%q: 명령 %d개, 기대 %d개", shell, got, want)
		}
	}
}

// 가드가 빠지면 엉뚱한 셸에서 실행된다 — 셸을 알고 보낼 때도 붙여 둔다(판정이 틀릴 수 있다).
func TestPerShellCommandsKeepTheirVersionGuard(t *testing.T) {
	bash := BashShellIntegrationInitCommand()
	if !strings.Contains(bash, `if [ -n "${BASH_VERSION:-}" ]; then `) || !strings.HasSuffix(strings.TrimSuffix(bash, "\r"), "|| true") {
		t.Errorf("bash 명령의 가드/꼬리가 어긋난다: %q", bash)
	}
	if strings.Contains(bash, "ZSH_VERSION") {
		t.Error("bash 명령에 zsh 분기가 남아 있다")
	}
	zsh := ZshShellIntegrationInitCommand()
	if !strings.Contains(zsh, `if [ -n "${ZSH_VERSION:-}" ]; then `) {
		t.Errorf("zsh 명령의 가드가 없다: %q", zsh)
	}
	if strings.Contains(zsh, "BASH_VERSION") {
		t.Error("zsh 명령에 bash 분기가 남아 있다")
	}
	// zsh 쪽은 bash 전용 히스토리 정리를 붙이지 않는다(zsh 에서는 no-op 이다).
	if strings.Contains(zsh, "history -d") {
		t.Error("zsh 명령에 bash 전용 히스토리 정리가 붙어 있다")
	}
}

// PS0 이 없는 bash(4.4 미만)용 명령 시작 폴백은 **bash 스크립트를 내보내는 모든 경로**에
// 들어 있어야 한다 — 로컬 기동 파일, 로컬·SSH·tmux·AWS 의 주입/재주입, 셸을 모를 때의 겸용
// 줄까지. 한 곳이라도 빠지면 그 경로에서만 명령 블록이 안 생긴다(A·B·D 만 오는 상태).
func TestBashCommandStartFallbackReachesEveryPath(t *testing.T) {
	carriers := map[string]string{
		"BashShellIntegrationInitCommand": BashShellIntegrationInitCommand(),
		"BashShellIntegrationScript":      BashShellIntegrationScript(),
		"InitLines(bash)":                 strings.Join(ShellIntegrationInitLines("bash"), ""),
		"InitLines(unknown)":              strings.Join(ShellIntegrationInitLines(""), ""),
	}
	for name, script := range carriers {
		if !strings.Contains(script, "trap '__ds_c' DEBUG") {
			t.Errorf("%s 에 DEBUG 트랩 폴백이 없다", name)
		}
		if !strings.Contains(script, "__ds_a=1") {
			t.Errorf("%s 에 트랩 깃발이 없다", name)
		}
		// 배열 첨자는 dash 가 파싱하다 죽는다 — 겸용 줄에도 그대로 가므로 금지다.
		if strings.Contains(script, "BASH_VERSINFO[") {
			t.Errorf("%s 가 배열 첨자를 쓴다(dash 파싱 불가)", name)
		}
	}
}
