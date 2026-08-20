package mobile

import (
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"dolssh/services/ssh-core/mobile/ringbuf"

	"golang.org/x/crypto/ssh"
)

// 앱이 넘기는 값이 모자라면 **여기서 막아야 한다.** 그냥 넘기면 러너가 웹소켓 주소 없이
// 열려다 실패하고, 화면에는 원인 없는 "연결 실패" 만 남는다.
func TestStartAwsSsmShellRejectsIncompleteRequests(t *testing.T) {
	engine := NewEngine()

	cases := []struct {
		name    string
		request string
		want    string
	}{
		{"세션 손잡이 없음", `{"streamUrl":"wss://x","tokenValue":"t"}`, "session id"},
		{"스트림 주소 없음", `{"id":"s1","tokenValue":"t"}`, "streamUrl"},
		{"토큰 없음", `{"id":"s1","streamUrl":"wss://x"}`, "tokenValue"},
		{"JSON 아님", `{`, "parse"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			shell, err := engine.StartAwsSsmShell(testCase.request, nil)
			if err == nil {
				shell.Close()
				t.Fatalf("거절해야 한다")
			}
			if !strings.Contains(err.Error(), testCase.want) {
				t.Fatalf("무엇이 빠졌는지 문구에 있어야 한다: %v", err)
			}
		})
	}
}

// 출력이 링 버퍼를 지나 구독자에게 닿는지. 이 경로가 끊기면 세션은 붙는데 화면이 비어 있다.
func TestStartAwsSsmShellStreamsOutputToListeners(t *testing.T) {
	// in-process 가짜 러너. 실제 데이터채널 대신 파이프로 같은 인터페이스를 만족한다.
	t.Setenv("DOLSSH_E2E_FAKE_AWS_SESSION", "1")

	engine := NewEngine()
	shell, err := engine.StartAwsSsmShell(
		`{"id":"ssm-1","region":"ap-northeast-2","instanceId":"i-1",`+
			`"streamUrl":"wss://example.invalid","tokenValue":"token","cols":80,"rows":24}`,
		nil,
	)
	if err != nil {
		t.Fatalf("세션이 열려야 한다: %v", err)
	}
	defer shell.Close()

	// **세션이 첫 출력을 낼 때까지 기다린 뒤 구독한다.** 앱도 `connected` 뒤에 붙이고, 그 전에
	// 입력을 밀어 넣으면 가짜 러너의 파이프가 읽는 쪽 없이 막힌다(실제 데이터채널에서는 오류가
	// 나지만, 순서는 어차피 같아야 한다).
	waitFor(t, 3*time.Second, func() bool { return shell.CurrentSeq() > 0 })

	collector := &collectingListener{}
	id := shell.AddListener(collector, 0, 0, 0, 0, 0)
	if id == 0 {
		t.Fatal("구독 id 가 있어야 한다")
	}

	// 가짜 러너는 처음 한 줄을 내보내고, 이후 입력을 그대로 되돌린다.
	if err := shell.SendData([]byte("hello\n")); err != nil {
		t.Fatalf("입력을 보낼 수 있어야 한다: %v", err)
	}

	waitFor(t, 3*time.Second, func() bool { return strings.Contains(collector.text(), "hello") })
	if got := collector.text(); !strings.Contains(got, "hello") {
		t.Fatalf("입력이 출력으로 돌아와야 한다: %q", got)
	}

	// 이력도 같은 링에서 읽힌다 — 화면을 다시 열 때 스크롤 복원이 이 경로다.
	if result := shell.ReadBuffer(0, 0, 0, 0, 1<<16); result == nil ||
		!strings.Contains(string(result.Data()), "hello") {
		t.Fatal("ReadBuffer 로도 같은 내용이 나와야 한다")
	}
	if shell.CurrentSeq() <= 0 {
		t.Fatal("순번이 진행돼야 한다")
	}

	shell.RemoveListener(id)
	before := collector.text()
	if err := shell.SendData([]byte("after\n")); err != nil {
		t.Fatalf("입력: %v", err)
	}
	time.Sleep(50 * time.Millisecond)
	if collector.text() != before {
		t.Fatal("구독을 끊었으면 더 오지 않아야 한다")
	}
}

// 크기 변경·제어 신호가 매니저까지 닿는지(세션이 없으면 오류가 난다).
func TestAwsSsmShellForwardsControls(t *testing.T) {
	t.Setenv("DOLSSH_E2E_FAKE_AWS_SESSION", "1")

	engine := NewEngine()
	shell, err := engine.StartAwsSsmShell(
		`{"id":"ssm-2","streamUrl":"wss://example.invalid","tokenValue":"token"}`,
		nil,
	)
	if err != nil {
		t.Fatalf("세션: %v", err)
	}

	waitFor(t, 3*time.Second, func() bool { return shell.CurrentSeq() > 0 })

	if err := shell.Resize(40, 120); err != nil {
		t.Fatalf("크기 변경: %v", err)
	}
	// 받아들이는 값은 interrupt·suspend·quit 다(runner_common.go).
	if err := shell.SendControlSignal("interrupt"); err != nil {
		t.Fatalf("제어 신호: %v", err)
	}
	if err := shell.Close(); err != nil {
		t.Fatalf("종료: %v", err)
	}
	// 두 번 닫아도 안전해야 한다 — 화면이 사라질 때와 세션이 끝날 때 둘 다 닫는다.
	_ = shell.Close()
}

func TestStartSsmPortForwardRejectsIncompleteRequests(t *testing.T) {
	engine := NewEngine()

	for _, request := range []string{
		`{"streamUrl":"wss://x","tokenValue":"t"}`,
		`{"id":"f1","tokenValue":"t"}`,
		`{"id":"f1","streamUrl":"wss://x"}`,
	} {
		if forward, err := engine.StartSsmPortForward(request); err == nil {
			forward.Stop()
			t.Fatalf("거절해야 한다: %s", request)
		}
	}
}

// EIC 는 세션마다 새 키를 요구한다. 만들어진 키로 실제로 SSH 인증을 할 수 있어야 한다.
func TestGenerateEphemeralSshKey(t *testing.T) {
	engine := NewEngine()

	raw, err := engine.GenerateEphemeralSshKey()
	if err != nil {
		t.Fatalf("키 생성: %v", err)
	}
	var result struct {
		PrivateKeyPem string `json:"privateKeyPem"`
		PublicKey     string `json:"publicKey"`
	}
	if err := json.Unmarshal([]byte(raw), &result); err != nil {
		t.Fatalf("JSON: %v", err)
	}
	if !strings.HasPrefix(result.PublicKey, "ssh-ed25519 ") {
		t.Fatalf("authorized_keys 한 줄이어야 한다: %q", result.PublicKey)
	}
	if strings.Contains(result.PublicKey, "\n") {
		t.Fatal("줄바꿈이 붙으면 EIC 가 거절한다")
	}

	// **개인키로 실제 서명자를 만들 수 있어야 한다.** 형식만 맞고 못 쓰는 키를 넘기면 SSH 인증이
	// 실패하는데, 그 실패는 EIC·터널을 다 지난 뒤에야 보인다.
	signer, err := ssh.ParsePrivateKey([]byte(result.PrivateKeyPem))
	if err != nil {
		t.Fatalf("개인키를 다시 읽을 수 있어야 한다: %v", err)
	}
	if got := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(signer.PublicKey()))); got != result.PublicKey {
		t.Fatalf("공개키가 짝이 맞아야 한다: %q != %q", got, result.PublicKey)
	}

	// 매번 새 키여야 한다 — 재사용하면 한 기기의 세션들이 같은 키를 공유한다.
	second, err := engine.GenerateEphemeralSshKey()
	if err != nil {
		t.Fatalf("키 생성: %v", err)
	}
	if second == raw {
		t.Fatal("세션마다 새 키를 만들어야 한다")
	}
}

// 출력 구독은 SSH 셸과 **같은 헬퍼**를 쓴다. 그 규칙이 깨지면 두 경로 중 한쪽만 스크롤 복원이
// 되는 식으로 갈리므로 여기서 직접 본다.
func TestOutputFanReplaysAndFollows(t *testing.T) {
	ring := ringbuf.New(1<<20, 64<<10)
	fan := newOutputFan(ring)

	// 구독 전에 쌓인 것도 재생돼야 한다 — 화면을 다시 열 때가 이 경우다.
	ring.Append(ringbuf.StreamStdout, []byte("before"))

	collector := &collectingListener{}
	id := fan.addListener(collector, 0, 0, 0, 0, 0)
	ring.Append(ringbuf.StreamStdout, []byte("after"))

	waitFor(t, 2*time.Second, func() bool { return strings.Contains(collector.text(), "after") })
	if got := collector.text(); !strings.Contains(got, "before") {
		t.Fatalf("구독 전 내용도 재생돼야 한다: %q", got)
	}

	fan.removeListener(id)
	before := collector.text()
	ring.Append(ringbuf.StreamStdout, []byte("gone"))
	time.Sleep(50 * time.Millisecond)
	if collector.text() != before {
		t.Fatal("구독을 끊으면 더 오지 않아야 한다")
	}
}

// waitFor 는 조건이 참이 될 때까지 기다린다. 비동기 경로라 고정 sleep 으로는 흔들린다.
func waitFor(t *testing.T, limit time.Duration, done func() bool) {
	t.Helper()
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) {
		if done() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("%s 안에 조건이 만족되지 않았다", limit)
}

type collectingListener struct {
	mu   sync.Mutex
	data []byte
}

func (l *collectingListener) OnChunk(seq int64, timeMs float64, stream int, data []byte) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.data = append(l.data, data...)
}

// 링 버퍼가 밀려 건너뛴 구간. 이 테스트에서는 일어나지 않지만 인터페이스가 요구한다.
func (l *collectingListener) OnDropped(int64, int64) {}

func (l *collectingListener) text() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return string(l.data)
}
