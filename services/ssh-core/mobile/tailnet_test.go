package mobile

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"dolssh/services/ssh-core/pkg/coretypes"
)

func TestMobileTailnetIdleGraceIsShorterThanDesktopReuseWindow(t *testing.T) {
	if mobileTailnetIdleGrace != 2*time.Minute {
		t.Fatalf("mobileTailnetIdleGrace = %s, want 2m", mobileTailnetIdleGrace)
	}
}

type recordingTailnetListener struct {
	mu     sync.Mutex
	events []coretypes.Event
}

func (listener *recordingTailnetListener) OnTailnetEvent(eventJSON string) {
	var event coretypes.Event
	if err := json.Unmarshal([]byte(eventJSON), &event); err != nil {
		return
	}
	listener.mu.Lock()
	listener.events = append(listener.events, event)
	listener.mu.Unlock()
}

func (listener *recordingTailnetListener) snapshot() []coretypes.Event {
	listener.mu.Lock()
	defer listener.mu.Unlock()
	return append([]coretypes.Event(nil), listener.events...)
}

func TestConfigureAndSnapshotTailnetsCrossTheMobileBoundary(t *testing.T) {
	engine := NewEngine()
	listener := &recordingTailnetListener{}
	root := t.TempDir()

	if err := engine.ConfigureTailnets(root, "https://sync.example.test|user-1", `{
		"configs":[{"id":"corp","controlUrl":"https://control.example.test"}]
	}`, listener); err != nil {
		t.Fatalf("ConfigureTailnets: %v", err)
	}
	t.Cleanup(func() { _ = engine.CloseTailnets() })

	if err := engine.SnapshotTailnets("snapshot-1"); err != nil {
		t.Fatalf("SnapshotTailnets: %v", err)
	}
	events := listener.snapshot()
	if len(events) != 1 {
		t.Fatalf("events = %d, want 1", len(events))
	}
	if events[0].Type != coretypes.EventTailnetSnapshot || events[0].RequestID != "snapshot-1" {
		t.Fatalf("event = %#v", events[0])
	}
}

func TestTailnetStateDirectoryIsScopedAndPathSafe(t *testing.T) {
	root := t.TempDir()
	first, err := scopedTailnetStateDir(root, "server-a|user-a")
	if err != nil {
		t.Fatal(err)
	}
	second, err := scopedTailnetStateDir(root, "server-b|user-a")
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("different account scopes share a Tailnet state directory")
	}
	if filepath.Dir(first) != root || strings.Contains(filepath.Base(first), "server-a") {
		t.Fatalf("unsafe scoped path = %q", first)
	}
}

func TestConfigureTailnetsReusesOnlyTheSameAccountScope(t *testing.T) {
	engine := NewEngine()
	root := t.TempDir()
	listener := &recordingTailnetListener{}

	if err := engine.ConfigureTailnets(root, "account-a", `{"configs":[]}`, listener); err != nil {
		t.Fatal(err)
	}
	first := engine.tailnetRuntime
	if err := engine.ConfigureTailnets(root, "account-a", `{"configs":[]}`, listener); err != nil {
		t.Fatal(err)
	}
	if engine.tailnetRuntime != first {
		t.Fatal("same account scope replaced the Tailnet runtime")
	}
	if err := engine.ConfigureTailnets(root, "account-b", `{"configs":[]}`, listener); err != nil {
		t.Fatal(err)
	}
	if engine.tailnetRuntime == first {
		t.Fatal("different account scope reused the previous Tailnet runtime")
	}
	_ = engine.CloseTailnets()
}

func TestTailnetCommandsRequireConfiguration(t *testing.T) {
	engine := NewEngine()
	if err := engine.SnapshotTailnets("snapshot"); err == nil {
		t.Fatal("SnapshotTailnets succeeded before ConfigureTailnets")
	}
	if err := engine.StartTailnet("start", `{"config":{"id":"corp"}}`); err == nil {
		t.Fatal("StartTailnet succeeded before ConfigureTailnets")
	}
}

func TestDialConfigRequiresAndUsesTheAccountTailnetRuntime(t *testing.T) {
	engine := NewEngine()
	direct, err := engine.dialConfig(connectRequest{})
	if err != nil {
		t.Fatalf("direct dial config: %v", err)
	}
	if direct.Dial != nil {
		t.Fatal("direct connection unexpectedly received a Tailnet dialer")
	}

	routedRequest := connectRequest{ConnectPayload: coretypes.ConnectPayload{
		TailnetID:   "corp",
		TailnetName: "example.com",
	}}
	if _, err := engine.dialConfig(routedRequest); err == nil {
		t.Fatal("Tailnet route succeeded before the account runtime was configured")
	}

	if err := engine.ConfigureTailnets(
		t.TempDir(),
		"account-a",
		`{"configs":[{"id":"corp"}]}`,
		nil,
	); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.CloseTailnets() })

	routed, err := engine.dialConfig(routedRequest)
	if err != nil {
		t.Fatalf("Tailnet dial config: %v", err)
	}
	if routed.Dial == nil {
		t.Fatal("Tailnet route did not install its dialer")
	}
}

func TestConfigureTailnetsRejectsUnsafeInput(t *testing.T) {
	engine := NewEngine()
	if err := engine.ConfigureTailnets("relative", "scope", `{"configs":[]}`, nil); err == nil {
		t.Fatal("relative state root was accepted")
	}
	if err := engine.ConfigureTailnets(t.TempDir(), "", `{"configs":[]}`, nil); err == nil {
		t.Fatal("empty state scope was accepted")
	}
	if err := engine.ConfigureTailnets(t.TempDir(), "scope", `{bad`, nil); err == nil {
		t.Fatal("malformed config JSON was accepted")
	}
}

func TestForgetTailnetPurgesAColdAccountScopedIdentity(t *testing.T) {
	engine := NewEngine()
	root := t.TempDir()
	const scope = "account-a"
	if err := engine.ConfigureTailnets(
		root,
		scope,
		`{"configs":[{"id":"corp"}]}`,
		nil,
	); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.CloseTailnets() })

	scoped, err := scopedTailnetStateDir(root, scope)
	if err != nil {
		t.Fatal(err)
	}
	identityDir := filepath.Join(scoped, "corp")
	if err := os.MkdirAll(identityDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(identityDir, "tailscaled.state"), []byte("state"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := engine.ForgetTailnet("corp"); err != nil {
		t.Fatalf("ForgetTailnet() error = %v", err)
	}
	if _, err := os.Stat(identityDir); !os.IsNotExist(err) {
		t.Fatalf("identity directory still exists after forget: %v", err)
	}
}

func TestCloseTailnetsPreservesAColdAccountScopedIdentity(t *testing.T) {
	engine := NewEngine()
	root := t.TempDir()
	const scope = "account-a"
	if err := engine.ConfigureTailnets(root, scope, `{"configs":[{"id":"corp"}]}`, nil); err != nil {
		t.Fatal(err)
	}
	scoped, err := scopedTailnetStateDir(root, scope)
	if err != nil {
		t.Fatal(err)
	}
	identityDir := filepath.Join(scoped, "corp")
	if err := os.MkdirAll(identityDir, 0o700); err != nil {
		t.Fatal(err)
	}

	if err := engine.CloseTailnets(); err != nil {
		t.Fatalf("CloseTailnets() error = %v", err)
	}
	if _, err := os.Stat(identityDir); err != nil {
		t.Fatalf("close removed reusable identity: %v", err)
	}
}
