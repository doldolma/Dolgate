//go:build !windows

package localsession

import (
	"os"
	"path/filepath"
	"strings"
	"sync"

	"dolssh/services/ssh-core/internal/autocomplete"
)

// 로컬 셸에는 통합을 **타이핑하지 않는다.**
//
// 우리가 셸을 직접 띄우므로 기동 파일로 넣을 수 있다 — 다른 터미널 앱들이 쓰는 방식이고, 그러면
// 타이핑에 딸린 문제가 통째로 사라진다: tty 의 한 줄 상한(MAX_CANON)도, 화면에서 echo 를 걷어내는
// 일도, 프롬프트가 뜰 때까지 기다리는 일도 필요 없다. 게다가 **첫 프롬프트부터** 마커가 붙는다
// (타이핑하면 첫 프롬프트는 훅이 없어 마커가 없다).
//
// 사용자 설정을 건드리지 않는 것이 핵심이다. 어느 방식이든 사용자의 rc 를 먼저 읽고 그 뒤에 우리
// 훅만 얹는다. 준비하지 못하면 조용히 예전 경로(stdin 주입)로 돌아간다 — 통합이 없는 것보다는
// 낫고, 잘못 끼어들어 사용자의 셸을 망가뜨리는 것보다는 훨씬 낫다.

const (
	shellStartupDirPrefix = "dolgate-shell-integration-"
	// 사용자의 원래 ZDOTDIR 를 zsh 심(shim)에 전달하는 환경 변수. 심이 이것으로 사용자의 설정을
	// 찾아 읽고, 다 읽은 뒤 ZDOTDIR 를 원래 값으로 되돌린다.
	zshUserZdotdirEnv = "DOLGATE_USER_ZDOTDIR"
)

var (
	shellStartupOnce sync.Once
	shellStartupDir  string
	shellStartupErr  error
)

// startupIntegrationDir 는 기동 파일들을 담을 디렉터리를 한 번만 만든다. 내용은 세션과 무관하게
// 같으므로 프로세스당 하나면 된다.
func startupIntegrationDir() (string, error) {
	shellStartupOnce.Do(func() {
		dir, err := os.MkdirTemp("", shellStartupDirPrefix+"*")
		if err != nil {
			shellStartupErr = err
			return
		}
		shellStartupDir = dir
	})
	return shellStartupDir, shellStartupErr
}

func writeStartupFile(dir string, name string, content string) (string, error) {
	path := filepath.Join(dir, name)
	if parent := filepath.Dir(path); parent != dir {
		if err := os.MkdirAll(parent, 0o700); err != nil {
			return "", err
		}
	}
	if err := os.WriteFile(path, []byte(content+"\n"), 0o600); err != nil {
		return "", err
	}
	return path, nil
}

// withShellStartupIntegration 는 셸 통합을 기동 파일로 넣도록 인자·환경을 고쳐 돌려준다.
// 마지막 값이 false 면 아무것도 바꾸지 않은 것이고, 호출부는 예전처럼 stdin 주입으로 간다.
func withShellStartupIntegration(
	shellKind string,
	args []string,
	env []string,
) ([]string, []string, bool) {
	switch autocomplete.NormalizeShellIntegrationShell(shellKind) {
	case "bash":
		return withBashStartupIntegration(args, env)
	case "zsh":
		return withZshStartupIntegration(args, env)
	case "fish":
		return withFishStartupIntegration(args, env)
	default:
		return args, env, false
	}
}

// bash 는 `--init-file` 로 rc 를 갈아끼운다. 사용자가 이미 rc 관련 인자를 준 경우에는 손대지
// 않는다 — 그 의도를 우리가 덮어쓰면 안 된다.
func withBashStartupIntegration(args []string, env []string) ([]string, []string, bool) {
	for _, arg := range args {
		switch arg {
		case "--init-file", "--rcfile", "--norc", "--noprofile", "-l", "--login":
			return args, env, false
		}
	}
	dir, err := startupIntegrationDir()
	if err != nil {
		return args, env, false
	}
	// 사용자의 .bashrc 를 먼저 읽는다 — `--init-file` 은 그것을 대신하므로 우리가 불러 줘야 한다.
	script := `if [ -f "${HOME}/.bashrc" ]; then . "${HOME}/.bashrc"; fi` + "\n" +
		autocomplete.BashShellIntegrationScript()
	path, err := writeStartupFile(dir, "bashrc", script)
	if err != nil {
		return args, env, false
	}
	return append(append([]string(nil), args...), "--init-file", path), env, true
}

// zsh 는 ZDOTDIR 를 우리 디렉터리로 돌려 심(shim)을 읽게 한다. 심은 사용자의 설정을 그대로 읽고
// 마지막에 ZDOTDIR 를 되돌린다 — 그래야 셸 안에서 그 값을 보는 설정들이 어긋나지 않는다.
func withZshStartupIntegration(args []string, env []string) ([]string, []string, bool) {
	dir, err := startupIntegrationDir()
	if err != nil {
		return args, env, false
	}
	userZdotdir, _ := envValue(env, "ZDOTDIR")
	if strings.TrimSpace(userZdotdir) == "" {
		userZdotdir, _ = envValue(env, "HOME")
	}
	if strings.TrimSpace(userZdotdir) == "" {
		return args, env, false
	}

	// 사용자 설정을 우리 것보다 **먼저** 읽는다. 순서가 뒤집히면 사용자의 PS1 설정이 우리 마커를
	// 지운다(zsh 는 PS1 을 통째로 대입하는 설정이 흔하다).
	sourceUser := func(name string) string {
		return `if [ -f "${` + zshUserZdotdirEnv + `}/` + name + `" ]; then ` +
			`. "${` + zshUserZdotdirEnv + `}/` + name + `"; fi`
	}
	// 사용자 파일이 ZDOTDIR 를 바꿨으면 **되돌린다.** `~/.config/zsh` 처럼 .zshenv 에서
	// ZDOTDIR 를 옮기는 구성이 흔한데, zsh 는 시작 파일마다 ZDOTDIR 를 다시 보므로 그대로
	// 두면 다음 파일(.zprofile·.zshrc)을 그 디렉터리에서 읽는다 — 우리 .zshrc 가 아예 실행되지
	// 않아 셸 통합이 조용히 꺼진다(자동완성·명령 블록·AI 컨텍스트가 전부). 사용자가 정한 값은
	// 사용자 디렉터리로 승격해 두어, 마지막에 되돌릴 때 그 값으로 돌아가게 한다.
	reclaim := `if [ "${ZDOTDIR}" != "` + dir + `" ]; then ` +
		zshUserZdotdirEnv + `="${ZDOTDIR}"; export ` + zshUserZdotdirEnv + `; ` +
		`ZDOTDIR="` + dir + `"; fi`
	files := map[string]string{
		".zshenv":   sourceUser(".zshenv") + "\n" + reclaim,
		".zprofile": sourceUser(".zprofile") + "\n" + reclaim,
		// .zshrc 가 대화형 셸의 마지막 단계다 — 여기서 훅을 얹고 ZDOTDIR 를 되돌린다.
		// 되돌린 뒤에는 zsh 가 .zlogin 을 사용자 디렉터리에서 직접 읽으므로 심이 필요 없다.
		// 되돌리기는 우리 값이 그대로 남아 있을 때만 한다 — 사용자의 .zshrc 가 스스로 ZDOTDIR 를
		// 정했다면 그 값을 덮어쓰면 안 된다.
		".zshrc": sourceUser(".zshrc") + "\n" +
			autocomplete.ZshShellIntegrationScript() + "\n" +
			`if [ "${ZDOTDIR}" = "` + dir + `" ]; then ZDOTDIR="${` + zshUserZdotdirEnv + `}"; fi`,
	}
	for name, content := range files {
		if _, err := writeStartupFile(dir, name, content); err != nil {
			return args, env, false
		}
	}
	nextEnv := setEnvValue(env, zshUserZdotdirEnv, userZdotdir)
	nextEnv = setEnvValue(nextEnv, "ZDOTDIR", dir)
	return args, nextEnv, true
}

// fish 는 사용자 설정을 건드릴 필요가 없다 — vendor_conf.d 에 파일 하나를 두면 기동할 때 읽는다.
func withFishStartupIntegration(args []string, env []string) ([]string, []string, bool) {
	dir, err := startupIntegrationDir()
	if err != nil {
		return args, env, false
	}
	if _, err := writeStartupFile(
		dir,
		filepath.Join("fish", "vendor_conf.d", "dolgate.fish"),
		autocomplete.FishShellIntegrationScript(),
	); err != nil {
		return args, env, false
	}
	// 기존 값을 지우면 시스템 설정(완성·함수)이 통째로 사라진다. 앞에 붙이기만 한다.
	existing, _ := envValue(env, "XDG_DATA_DIRS")
	if strings.TrimSpace(existing) == "" {
		existing = "/usr/local/share:/usr/share"
	}
	return args, setEnvValue(env, "XDG_DATA_DIRS", dir+":"+existing), true
}

func setEnvValue(env []string, key string, value string) []string {
	prefix := key + "="
	next := make([]string, 0, len(env)+1)
	for _, entry := range env {
		if strings.HasPrefix(entry, prefix) {
			continue
		}
		next = append(next, entry)
	}
	return append(next, prefix+value)
}
