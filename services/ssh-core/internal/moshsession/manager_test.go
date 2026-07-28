package moshsession

import (
	"context"
	"errors"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/protocol"
)

func TestParseMoshConnect(t *testing.T) {
	port, key, err := parseMoshConnect([]byte("\r\nMOSH CONNECT 60001 4NeCCgvZFe2RnPgrcU1PQw\r\n"))
	if err != nil {
		t.Fatalf("parseMoshConnect() error = %v", err)
	}
	if port != 60001 {
		t.Fatalf("port = %d, want 60001", port)
	}
	if key != "4NeCCgvZFe2RnPgrcU1PQw" {
		t.Fatalf("key = %q, want 4NeCCgvZFe2RnPgrcU1PQw", key)
	}
}

func TestParseMoshConnectEmbeddedInNoise(t *testing.T) {
	// mosh-server may print banners / locale warnings around the MOSH CONNECT line.
	out := []byte("mosh-server (mosh 1.4.0)\nMOSH CONNECT 1234 abcDEF123\nMosh server now listening\n")
	port, key, err := parseMoshConnect(out)
	if err != nil || port != 1234 || key != "abcDEF123" {
		t.Fatalf("got port=%d key=%q err=%v", port, key, err)
	}
}

func TestParseMoshConnectFailure(t *testing.T) {
	if _, _, err := parseMoshConnect([]byte("bash: mosh-server: command not found\n")); err == nil {
		t.Fatal("expected error when MOSH CONNECT is absent")
	}
}

func TestMoshStateFor(t *testing.T) {
	cases := []struct {
		age  time.Duration
		want string
	}{
		{0, "connected"},
		{2 * time.Second, "connected"},
		{5 * time.Second, "reconnecting"},
		{11 * time.Second, "reconnecting"},
		{15 * time.Second, "disconnected"},
	}
	for _, tc := range cases {
		if got := moshStateFor(tc.age); got != tc.want {
			t.Fatalf("moshStateFor(%s) = %q, want %q", tc.age, got, tc.want)
		}
	}
}

func TestMoshServerCommandUsesLocaleAndFlags(t *testing.T) {
	cmd := moshServerCommand(nil)
	if !strings.Contains(cmd, "mosh-server new") {
		t.Fatalf("command missing subcommand: %q", cmd)
	}
	if !strings.Contains(cmd, "LANG=en_US.UTF-8") {
		t.Fatalf("command missing default locale: %q", cmd)
	}
}

func TestLocaleFromEnvPrefersUTF8(t *testing.T) {
	env := []protocol.EnvVar{
		{Key: "LANG", Value: "ko_KR.UTF-8"},
	}
	if got := localeFromEnv(env); got != "ko_KR.UTF-8" {
		t.Fatalf("localeFromEnv = %q, want ko_KR.UTF-8", got)
	}
	// Non-UTF-8 LANG is ignored in favor of the safe default.
	if got := localeFromEnv([]protocol.EnvVar{{Key: "LANG", Value: "C"}}); got != "en_US.UTF-8" {
		t.Fatalf("localeFromEnv(C) = %q, want en_US.UTF-8 fallback", got)
	}
}

// tailnet 을 지정한 호스트는 mosh 도 그 안으로 가야 한다. bootstrap 만 태우면 UDP 가 일반
// 네트워크로 나가는데, tailnet 안에만 있는 호스트에는 닿지 않고 조용히 실패한다 — 사용자
// 입장에서는 "tailnet 설정했는데 mosh 만 안 된다"가 된다.
func TestDialMoshOpensTheUDPLegThroughTheTailnet(t *testing.T) {
	var gotNetwork, gotAddr string
	manager := NewManagerWithConfig(nil, nil, ManagerConfig{})
	dial := func(_ context.Context, network, address string) (net.Conn, error) {
		gotNetwork, gotAddr = network, address
		return nil, errors.New("dial refused")
	}

	_, err := manager.dialMosh(dial, "agt-1", 60001, "AAECAwQFBgcICQoLDA0ODw")
	if err == nil {
		t.Fatal("dialMosh() error = nil, want the dialer's failure to surface")
	}
	if !strings.Contains(err.Error(), "tailnet udp") {
		t.Errorf("error = %q, want it to name the tailnet udp leg", err)
	}

	if gotNetwork != "udp4" {
		t.Errorf("dialed network = %q, want udp4 — TCP 로 열면 mosh 전송이 아니다", gotNetwork)
	}
	// 이름을 그대로 넘겨야 한다. mosh.Dial 은 net.ParseIP 를 쓰므로 이름을 못 받지만, tailnet
	// dialer 는 MagicDNS 를 해석한다 — 그래서 이 경로에서는 IP 로 바꾸지 않는다.
	if gotAddr != "agt-1:60001" {
		t.Errorf("dialed address = %q, want agt-1:60001", gotAddr)
	}
}

// 키가 깨졌으면 dial 하기 전에 끊어야 한다. 먼저 열면 tailnet 리스를 잡았다가 놓을 자리가
// 없어져, 노드가 유예에 들어가지 못하고 계속 떠 있는다.
func TestDialMoshRejectsABadKeyBeforeDialing(t *testing.T) {
	manager := NewManagerWithConfig(nil, nil, ManagerConfig{})
	dialed := false
	dial := func(context.Context, string, string) (net.Conn, error) {
		dialed = true
		return nil, errors.New("should not be reached")
	}

	if _, err := manager.dialMosh(dial, "agt-1", 60001, "!!!not-base64!!!"); err == nil {
		t.Fatal("dialMosh() error = nil, want a key failure")
	}
	if dialed {
		t.Error("dialed before validating the key — 실패 경로에서 리스가 새는 자리다")
	}
}

// mosh-server 는 패딩 없는 base64 를 출력한다. 붙여 주지 않으면 정상 키가 디코딩 실패한다.
func TestMoshOCBFromKeyPadsBase64(t *testing.T) {
	// 16 바이트 키의 패딩 없는 표현.
	unpadded := "AAECAwQFBgcICQoLDA0ODw"
	if _, err := moshOCBFromKey(unpadded); err != nil {
		t.Fatalf("moshOCBFromKey(%q) error = %v, want it to pad and succeed", unpadded, err)
	}
	if _, err := moshOCBFromKey("!!!"); err == nil {
		t.Error("moshOCBFromKey() accepted a non-base64 key")
	}
}

// mosh.Dial 은 host 를 net.ParseIP 로 해석해서 이름을 받으면 nil 이 되고, net.DialUDP 는
// 그것을 거부하지 않고 **127.0.0.1 로 연결한다.** UDP 는 핸드셰이크가 없으니 dial·write 가 다
// 성공해서, 부트스트랩까지 정상으로 보인 뒤 세션만 영원히 응답을 못 받는다. 주소가 IP 리터럴인
// 호스트만 우연히 동작하던 버그다.
//
// 그 조용한 성공이 이 버그의 특징이므로, 해석 실패가 실패로 드러나는지로 확인한다. 이름이
// 해석되는 경우로는 구분되지 않는다 — loopback 폴백이 우연히 맞는 곳으로 갈 수 있다.
func TestDialMoshFailsOnAnUnresolvableNameInsteadOfUsingLoopback(t *testing.T) {
	manager := NewManagerWithConfig(nil, nil, ManagerConfig{})

	// .invalid 는 RFC 2606 예약 TLD 로 해석되지 않는다.
	client, err := manager.dialMosh(nil, "no-such-host.invalid", 60001, "AAECAwQFBgcICQoLDA0ODw")
	if err == nil {
		client.Close()
		t.Fatal("해석되지 않는 이름인데 연결에 성공했다 — loopback 으로 붙었다는 뜻이다")
	}
	if !strings.Contains(err.Error(), "udp") {
		t.Errorf("error = %q, want it to name the udp leg", err)
	}
}

// 해석되는 이름은 실제 대상으로 가야 한다. 위 테스트가 "실패가 실패로 보이는지"를 보므로,
// 이쪽은 정상 경로가 실제로 데이터그램을 배달하는지를 본다.
func TestDialMoshDeliversToTheResolvedTarget(t *testing.T) {
	server, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		t.Fatalf("ListenUDP() error = %v", err)
	}
	defer server.Close()
	port := server.LocalAddr().(*net.UDPAddr).Port

	manager := NewManagerWithConfig(nil, nil, ManagerConfig{})
	client, err := manager.dialMosh(nil, "localhost", port, "AAECAwQFBgcICQoLDA0ODw")
	if err != nil {
		t.Fatalf("dialMosh() error = %v", err)
	}
	defer client.Close()

	if err := server.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatalf("SetReadDeadline() error = %v", err)
	}
	buf := make([]byte, 2048)
	n, _, readErr := server.ReadFromUDP(buf)
	if readErr != nil {
		t.Fatalf("서버가 아무것도 받지 못했다: %v", readErr)
	}
	if n == 0 {
		t.Error("빈 데이터그램이 도착했다")
	}
}

// "한 번도 못 받았다"와 "받다가 끊겼다"는 사용자가 할 일이 다르다. 전자는 거의 항상 방화벽
// (mosh 의 UDP 포트가 SSH 와 별개)이고, 후자는 기다리면 로밍으로 복구된다.
//
// mosh-go 가 lastRecv 를 생성 시각으로 초기화하므로 IsZero 로는 구분되지 않는다 — 그래서
// 세션 생성 시각과 비교한다. 이 판정이 없으면 응답이 없어도 "연결됨 · N초 전 응답"으로
// 보이고, 사용자에게는 원인을 찾을 단서가 없다.
func TestMoshHasReceivedAnythingComparesAgainstSessionStart(t *testing.T) {
	started := time.Now()

	// 생성 시각과 같거나 이전이면 아직 아무것도 못 받은 것이다(mosh-go 의 초기화 값).
	if moshHasReceivedAnything(started, started) {
		t.Error("생성 시각과 같은 lastRecv 를 실제 수신으로 봤다")
	}
	if moshHasReceivedAnything(started, started.Add(-time.Millisecond)) {
		t.Error("생성 시각보다 이전인 lastRecv 를 실제 수신으로 봤다")
	}

	// 그 뒤로 갱신됐으면 실제 수신이다.
	if !moshHasReceivedAnything(started, started.Add(time.Millisecond)) {
		t.Error("생성 이후 갱신된 lastRecv 를 수신으로 보지 않았다")
	}
}

// 기본 핸드셰이크 예산이 없으면 첫 응답을 기다리지 않고 통과해 버린다.
func TestManagerFillsInTheHandshakeTimeout(t *testing.T) {
	manager := NewManagerWithConfig(nil, nil, ManagerConfig{})
	if manager.config.HandshakeTimeout <= 0 {
		t.Fatalf("HandshakeTimeout = %v, want a positive default", manager.config.HandshakeTimeout)
	}
}

// 첫 SSP 응답을 기다리는 동작이 계약이다.
//
// 기다리지 않고 connected 를 먼저 보내면, 응답이 영원히 안 오는 경우가 "연결됐다가 나중에
// 끊긴 세션"이 된다. 그 경로는 탭을 조용히 없애서 사용자에게 이유가 남지 않는다 — 실제로
// 그렇게 보였고, 원인(UDP 차단)을 찾는 데 한참 걸렸다.
func TestAwaitFirstResponseFailsWithAnActionableMessage(t *testing.T) {
	// 예산을 짧게 줘서 테스트가 기본값(10 초)을 기다리지 않게 한다.
	manager := NewManagerWithConfig(nil, nil, ManagerConfig{
		HandshakeTimeout: 50 * time.Millisecond,
	})

	// 아무도 답하지 않는 대상. 응답이 올 수 없으므로 핸드셰이크 타임아웃을 탄다.
	server, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		t.Fatalf("ListenUDP() error = %v", err)
	}
	port := server.LocalAddr().(*net.UDPAddr).Port
	// 소켓을 닫아 아무도 듣지 않게 만든다.
	server.Close()

	client, err := manager.dialMosh(nil, "localhost", port, "AAECAwQFBgcICQoLDA0ODw")
	if err != nil {
		t.Fatalf("dialMosh() error = %v", err)
	}
	defer client.Close()

	// 실제 코드와 같은 순서다 — DialConn 뒤에 startedAt 을 잡아야 mosh-go 가 초기화해 둔
	// lastRecv 가 그보다 앞서고, 그래야 "아직 못 받았다"로 판정된다. 과거 시점으로 잡으면
	// 초기값이 실제 수신처럼 보여 이 테스트가 통과해 버린다(처음에 그렇게 틀렸다).
	handle := &sessionHandle{
		client:    client,
		closed:    make(chan struct{}),
		startedAt: time.Now(),
	}

	err = manager.awaitFirstResponse(handle)
	if err == nil {
		t.Fatal("awaitFirstResponse() error = nil, want a handshake failure")
	}
	// 사용자가 할 일이 메시지에 있어야 한다. "timeout" 만으로는 원인을 알 수 없다.
	for _, want := range []string{"UDP", "60000-61000"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error = %q, want it to mention %q", err, want)
		}
	}
}

// 응답이 이미 왔으면 곧바로 통과해야 한다. 정상 연결에 지연을 더하면 안 된다.
func TestAwaitFirstResponseReturnsImmediatelyOnceReceived(t *testing.T) {
	manager := NewManagerWithConfig(nil, nil, ManagerConfig{})
	handle := &sessionHandle{
		closed: make(chan struct{}),
		// startedAt 을 과거로 두면 mosh-go 가 생성 시각으로 잡아 둔 lastRecv 가 그보다 뒤이므로
		// "이미 받았다"로 판정된다 — 실제 수신과 같은 상태다.
		startedAt: time.Now().Add(-time.Second),
	}
	client, err := manager.dialMosh(nil, "localhost", 1, "AAECAwQFBgcICQoLDA0ODw")
	if err != nil {
		t.Fatalf("dialMosh() error = %v", err)
	}
	defer client.Close()
	handle.client = client

	started := time.Now()
	if err := manager.awaitFirstResponse(handle); err != nil {
		t.Fatalf("awaitFirstResponse() error = %v", err)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Errorf("waited %v — 이미 받은 세션에서 기다렸다", elapsed)
	}
}

// 순서가 계약이다. 첫 SSP 응답을 확인하기 **전에** connected 를 보내면, 응답이 안 오는 경우가
// "연결됐다가 끊긴 세션"이 되어 탭이 조용히 사라진다 — 사용자에게 이유가 남지 않는다.
//
// 함수 단위 테스트로는 이 배선이 잡히지 않는다(호출을 지워도 각 함수는 그대로 통과한다).
// 그래서 소스에서 순서를 확인한다 — tailnet 배선 테스트와 같은 방식이다.
func TestConnectWaitsForTheFirstResponseBeforeReportingConnected(t *testing.T) {
	source, err := os.ReadFile("manager.go")
	if err != nil {
		t.Fatalf("read manager.go: %v", err)
	}
	body := string(source)

	waitAt := strings.Index(body, "awaitFirstResponse(handle)")
	if waitAt < 0 {
		t.Fatal("Connect 가 첫 응답을 기다리지 않는다 — 실패가 '나중에 끊김'으로 바뀐다")
	}
	connectedAt := strings.Index(body, "protocol.EventConnected")
	if connectedAt < 0 {
		t.Fatal("connected 이벤트를 찾을 수 없다")
	}
	if waitAt > connectedAt {
		t.Error("connected 를 첫 응답 확인보다 먼저 보낸다 — 실패가 탭이 사라지는 경로를 탄다")
	}
}
