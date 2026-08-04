package mobile

import (
	"os"
	"path/filepath"
	"testing"
)

// tailscale 은 TS_LOGS_DIR 을 os.Stat 으로 확인하고 디렉터리가 아니면 무시한다. 알려 주기만 하고
// 만들지 않으면 안드로이드에서 다시 panic 하는 자리로 돌아간다.
func TestSetTailnetLogsDirCreatesAndAnnouncesTheDirectory(t *testing.T) {
	t.Setenv(tailnetLogsDirEnv, "")
	dir := filepath.Join(t.TempDir(), "tailnets", "logs")

	if err := setTailnetLogsDir(dir); err != nil {
		t.Fatalf("setTailnetLogsDir() error = %v", err)
	}

	if got := os.Getenv(tailnetLogsDirEnv); got != dir {
		t.Errorf("%s = %q, want %q", tailnetLogsDirEnv, got, dir)
	}
	info, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("만들어지지 않았다: %v", err)
	}
	if !info.IsDir() {
		t.Error("디렉터리가 아니다 — tailscale 이 이 값을 무시한다")
	}
}

// 밖에서 정한 자리를 우리가 덮을 이유가 없다.
func TestSetTailnetLogsDirKeepsAnExistingSetting(t *testing.T) {
	existing := t.TempDir()
	t.Setenv(tailnetLogsDirEnv, existing)

	untouched := filepath.Join(t.TempDir(), "logs")
	if err := setTailnetLogsDir(untouched); err != nil {
		t.Fatalf("setTailnetLogsDir() error = %v", err)
	}

	if got := os.Getenv(tailnetLogsDirEnv); got != existing {
		t.Errorf("%s = %q, want %q", tailnetLogsDirEnv, got, existing)
	}
	if _, err := os.Stat(untouched); !os.IsNotExist(err) {
		t.Errorf("쓰지 않을 자리를 만들었다: err = %v", err)
	}
}

// 만들 수 없으면 조용히 넘기지 않는다. 넘기면 나중에 tsnet 이 panic 해서 프로세스가 사라진다.
func TestSetTailnetLogsDirFailsWhenItCannotCreate(t *testing.T) {
	t.Setenv(tailnetLogsDirEnv, "")
	blocker := filepath.Join(t.TempDir(), "not-a-dir")
	if err := os.WriteFile(blocker, []byte("x"), 0o600); err != nil {
		t.Fatalf("픽스처 준비 실패: %v", err)
	}

	if err := setTailnetLogsDir(filepath.Join(blocker, "logs")); err == nil {
		t.Fatal("오류 없이 통과했다")
	}
	if got := os.Getenv(tailnetLogsDirEnv); got != "" {
		t.Errorf("%s = %q — 실패했는데 값을 남겼다", tailnetLogsDirEnv, got)
	}
}

// 이 우회는 안드로이드만의 것이다. iOS·데스크톱에서는 tailscale 의 기본 경로가 살아 있어야 한다.
func TestConfigureAndroidTailnetLogsDirOnlyTouchesAndroid(t *testing.T) {
	t.Setenv(tailnetLogsDirEnv, "")
	root := t.TempDir()

	if err := configureAndroidTailnetLogsDir(root); err != nil {
		t.Fatalf("configureAndroidTailnetLogsDir() error = %v", err)
	}

	// 이 테스트는 안드로이드가 아닌 곳에서 돈다.
	if got := os.Getenv(tailnetLogsDirEnv); got != "" {
		t.Errorf("%s = %q — 안드로이드가 아닌데 자리를 바꿨다", tailnetLogsDirEnv, got)
	}
	if _, err := os.Stat(filepath.Join(root, androidTailnetLogsDirName)); !os.IsNotExist(err) {
		t.Errorf("안드로이드가 아닌데 디렉터리를 만들었다: err = %v", err)
	}
}
