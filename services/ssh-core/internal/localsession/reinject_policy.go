package localsession

import (
	"strings"

	"dolssh/services/ssh-core/internal/autocomplete"
)

// shouldArmSubshellReinject 는 이 힌트로 서브셸 재주입을 무장할지 정한다.
//
// **플랫폼으로 가르지 않는다.** 예전에는 윈도우면 통째로 접었고 이유는 "주입 스크립트가 POSIX
// 모양이라 윈도우 서브셸에서 못 쓴다" 였는데, 전제가 틀렸다 — 윈도우 터미널에서 들어가는
// 서브셸의 상당수가 리눅스 셸이다(`wsl`, `bash`, `ssh user@host`). 거기엔 POSIX 스크립트가
// 정확히 맞고, 막아 두면 그 경우에 통합이 아예 없다.
//
// 남는 위험은 "포그라운드가 여전히 PowerShell 인데 POSIX 문법을 타이핑하는 것" 하나인데, 그건
// **서브셸이 뜨지 않았을 때**만 생긴다(진입 명령 실패). 그 경우는 돌아온 프롬프트에 우리 마커가
// 붙어 있으므로 게이트 콜백에서 접는다(PromptAlreadyIntegrated). 그래서 여기서는 "보낼 것이
// 있는가" 만 본다.
//
// 훅을 걸 수 없는 셸(dash·ksh·cmd)이면 보낼 것이 없다 — 타이핑해 봐야 화면만 더럽힌다.
//
// 이름을 모르면(빈 값) 무장한다. 예전에는 그때 겸용 스크립트를 보냈지만, 지금은 프로브 한 줄로
// 셸을 먼저 확인하고 그 답에 따라 보내거나 만다.
func shouldArmSubshellReinject(shell string) bool {
	if strings.TrimSpace(shell) == "" {
		return true
	}
	return len(autocomplete.ShellIntegrationInitLines(shell)) > 0
}
