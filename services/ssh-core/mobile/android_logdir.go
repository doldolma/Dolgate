package mobile

// 안드로이드에는 Go 가 쓸 수 있는 임시·캐시 디렉터리가 없다.
//
// tailscale 은 LocalBackend 를 만들 때 로그 상태를 둘 자리를 찾는데(ipn/ipnlocal 이
// logpolicy.LogsDir 을 인자로 평가한다) 안드로이드에서는 후보가 전부 막힌다: TS_LOGS_DIR 이 비어
// 있고, GOOS 별 분기에 android 가 없고, /var/lib/tailscale 은 만들 수 없고, os.UserCacheDir 은
// HOME·XDG_CACHE_HOME 이 없어 실패하고, 앱의 작업 디렉터리는 "/" 이고, os.MkdirTemp 가 쓰는
// /data/local/tmp 에는 앱이 쓸 수 없다. 그래서 마지막 줄에서 죽는다:
//
//	panic: no safe place found to store log state
//
// 인터페이스 목록(android_network.go)과 달리 이건 안드로이드에 물어볼 것이 없다 — 앱 샌드박스
// 경로는 우리가 이미 알고 있으므로, tailscale 이 가장 먼저 보는 TS_LOGS_DIR 에 그 자리를 알려 주면
// 된다.
//
// iOS 는 os.UserCacheDir 이 샌드박스 안(Library/Caches)을 가리켜 이 경로가 필요 없다. 그래서
// 안드로이드에서만 손댄다.

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// tailnetLogsDirEnv 는 tailscale 이 로그 상태 위치로 가장 먼저 읽는 환경변수다.
const tailnetLogsDirEnv = "TS_LOGS_DIR"

// androidTailnetLogsDirName 은 상태 루트 안에서 그 자리의 이름이다. 루트의 다른 자식은 전부
// 계정 스코프의 sha256 hex 라(scopedTailnetStateDir) 이름이 겹칠 수 없다.
const androidTailnetLogsDirName = "logs"

// configureAndroidTailnetLogsDir 은 안드로이드에서 tailscale 의 로그 상태 자리를 앱 샌드박스 안으로
// 돌린다. 다른 플랫폼에서는 아무것도 하지 않는다.
func configureAndroidTailnetLogsDir(stateRoot string) error {
	if runtime.GOOS != "android" {
		return nil
	}
	root := strings.TrimSpace(stateRoot)
	if root == "" {
		return nil
	}
	return setTailnetLogsDir(filepath.Join(root, androidTailnetLogsDirName))
}

// setTailnetLogsDir 은 자리를 만들고 tailscale 에 알려 준다.
//
// 이미 값이 있으면 그대로 둔다 — 밖에서 정한 자리를 우리가 덮을 이유가 없다. tailscale 은 그 값을
// os.Stat 으로 확인하고 디렉터리가 아니면 무시하므로, 알려 주기 전에 만들어야 한다.
func setTailnetLogsDir(dir string) error {
	if strings.TrimSpace(os.Getenv(tailnetLogsDirEnv)) != "" {
		return nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("mobile: tailnet log directory: %w", err)
	}
	return os.Setenv(tailnetLogsDirEnv, dir)
}
