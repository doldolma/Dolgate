package main

import (
	"encoding/json"
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/protocol"
)

func controlFrame(t *testing.T, request protocol.Request) protocol.Frame {
	t.Helper()
	metadata, err := json.Marshal(request)
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	return protocol.Frame{Kind: protocol.FrameKindControl, Metadata: metadata}
}

func streamFrame(t *testing.T, sessionID, data string) protocol.Frame {
	t.Helper()
	metadata, err := json.Marshal(protocol.StreamFrame{
		Type:      protocol.StreamTypeWrite,
		SessionID: sessionID,
	})
	if err != nil {
		t.Fatalf("marshal stream metadata: %v", err)
	}
	return protocol.Frame{
		Kind:     protocol.FrameKindStream,
		Metadata: metadata,
		Payload:  []byte(data),
	}
}

func awaitClosed(t *testing.T, what string, signal <-chan struct{}) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(3 * time.Second):
		t.Fatalf("%s: 신호가 오지 않았다", what)
	}
}

// 같은 세션의 입력은 순서를 지켜야 한다.
//
// 프레임마다 자유롭게 병렬로 돌리면 타이핑 순서가 뒤집힌다. 첫 입력을 붙잡아 두고 뒤 입력 두 개를
// 넣어, 앞이 풀릴 때까지 뒤가 기록되지 않는지 본다.
func TestRouterKeepsPerSessionOrder(t *testing.T) {
	core := &stubCoreRuntime{inputGate: make(chan struct{})}
	router := newFrameRouter(core, newEventWriter())

	router.route(streamFrame(t, "session-1", "first"))
	// 첫 입력이 붙잡힐 때까지 기다린다(그 뒤에 넣어야 순서 검사가 의미를 갖는다).
	for attempt := 0; attempt < 300; attempt += 1 {
		core.mu.Lock()
		started := core.inputGateUsed
		core.mu.Unlock()
		if started {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	router.route(streamFrame(t, "session-1", "second"))
	router.route(streamFrame(t, "session-1", "third"))

	// 아직 아무것도 기록되지 않았어야 한다 — 뒤 프레임이 앞을 앞질렀다면 여기서 드러난다.
	time.Sleep(50 * time.Millisecond)
	core.mu.Lock()
	early := append([]string(nil), core.inputs...)
	core.mu.Unlock()
	if len(early) != 0 {
		t.Fatalf("첫 입력이 끝나기 전에 기록된 것이 있다: %v", early)
	}

	close(core.inputGate)
	for attempt := 0; attempt < 300; attempt += 1 {
		core.mu.Lock()
		count := len(core.inputs)
		core.mu.Unlock()
		if count == 3 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	core.mu.Lock()
	got := append([]string(nil), core.inputs...)
	core.mu.Unlock()
	if len(got) != 3 || got[0] != "first" || got[1] != "second" || got[2] != "third" {
		t.Fatalf("입력 순서 = %v, want [first second third]", got)
	}
}

// 한 대상이 막혀도 다른 대상은 계속 처리돼야 한다.
//
// 실기기 증상: OTP 호스트로 포워딩을 시작하면 그 뒤로 SSH·SFTP·컨테이너·ECS·tailnet 조회가 전부
// 타임아웃 났다. 포워딩 하나가 프레임 루프를 붙잡고 있었기 때문이다.
func TestRouterIsolatesDifferentTargets(t *testing.T) {
	core := &stubCoreRuntime{
		forwardStarted:      make(chan struct{}),
		forwardRelease:      make(chan struct{}),
		tailnetSnapshotDone: make(chan struct{}),
	}
	defer core.releaseForward()
	router := newFrameRouter(core, newEventWriter())

	router.route(controlFrame(t, protocol.Request{
		ID:         "forward-1",
		Type:       protocol.CommandPortForwardStart,
		EndpointID: "rule-1",
		Payload:    mustMarshal(t, protocol.PortForwardStartPayload{Host: "192.168.200.37", Port: 22}),
	}))
	awaitClosed(t, "포워딩 시작", core.forwardStarted)

	// 다른 대상들: 전역(tailnet 조회)과 세션(입력)
	router.route(controlFrame(t, protocol.Request{ID: "snapshot-1", Type: protocol.CommandTailnetSnapshot}))
	router.route(streamFrame(t, "session-1", "hello"))

	awaitClosed(t, "포워딩 대기 중 tailnetSnapshot", core.tailnetSnapshotDone)
	for attempt := 0; attempt < 300; attempt += 1 {
		core.mu.Lock()
		count := len(core.inputs)
		core.mu.Unlock()
		if count == 1 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("포워딩 대기 중에 세션 입력이 처리되지 않았다")
}

// 인증 응답은 그것을 기다리는 작업이 진행 중이어도 반드시 처리돼야 한다.
//
// 이것이 교착의 핵심이었다: 답이 다음 프레임으로 오는데, 그 프레임을 읽고 처리할 주체가 답을
// 기다리는 작업에 붙잡혀 있었다.
func TestRouterServesAuthAnswerWhileTargetIsBlocked(t *testing.T) {
	core := &stubCoreRuntime{
		forwardStarted: make(chan struct{}),
		forwardRelease: make(chan struct{}),
		respondDone:    make(chan struct{}),
	}
	defer core.releaseForward()
	router := newFrameRouter(core, newEventWriter())

	router.route(controlFrame(t, protocol.Request{
		ID:         "forward-1",
		Type:       protocol.CommandPortForwardStart,
		EndpointID: "rule-1",
		Payload:    mustMarshal(t, protocol.PortForwardStartPayload{Host: "192.168.200.37", Port: 22}),
	}))
	awaitClosed(t, "포워딩 시작", core.forwardStarted)

	// 같은 엔드포인트의 응답이라도 줄을 서지 않아야 한다.
	router.route(controlFrame(t, protocol.Request{
		ID:         "respond-1",
		Type:       protocol.CommandKeyboardInteractiveRespond,
		EndpointID: "rule-1",
		Payload: mustMarshal(t, protocol.KeyboardInteractiveRespondPayload{
			ChallengeID: "rule-1-1",
			Responses:   []string{"196399"},
		}),
	}))
	awaitClosed(t, "인증 응답", core.respondDone)
}

// 배차는 무슨 일이 있어도 막히지 않아야 한다(읽기 고루틴이 곧 그 배차다).
func TestRouterNeverBlocksTheReader(t *testing.T) {
	core := &stubCoreRuntime{
		forwardStarted: make(chan struct{}),
		forwardRelease: make(chan struct{}),
		inputGate:      make(chan struct{}),
	}
	defer func() {
		core.releaseForward()
		close(core.inputGate)
	}()
	router := newFrameRouter(core, newEventWriter())

	started := time.Now()
	router.route(controlFrame(t, protocol.Request{
		ID:         "forward-1",
		Type:       protocol.CommandPortForwardStart,
		EndpointID: "rule-1",
		Payload:    mustMarshal(t, protocol.PortForwardStartPayload{Host: "192.168.200.37", Port: 22}),
	}))
	for index := 0; index < 100; index += 1 {
		router.route(streamFrame(t, "session-1", "x"))
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("배차가 %v 걸렸다 — 읽기 고루틴이 막힌다", elapsed)
	}
}

// 끝난 줄은 정리돼야 한다(대상이 계속 늘어나는 앱에서 맵이 무한히 자라지 않게).
func TestRouterCleansUpFinishedLanes(t *testing.T) {
	core := &stubCoreRuntime{}
	router := newFrameRouter(core, newEventWriter())

	for index := 0; index < 5; index += 1 {
		router.route(streamFrame(t, "session-1", "x"))
		router.route(controlFrame(t, protocol.Request{ID: "snapshot", Type: protocol.CommandTailnetSnapshot}))
	}

	for attempt := 0; attempt < 300 && router.pending() != 0; attempt += 1 {
		time.Sleep(5 * time.Millisecond)
	}
	if pending := router.pending(); pending != 0 {
		t.Fatalf("남은 줄 = %d, want 0", pending)
	}
}

// tailnet 설정은 그 뒤에 온 프레임보다 먼저 적용돼야 한다.
//
// 설정 프레임은 응답을 기다리지 않고 보내진다(코어가 뜰 때 한 번). 단일 줄 시절에는 순서가 우연히
// 지켜졌지만, 대상별로 나누면 설정(전역)과 연결(세션)이 다른 줄이라 뒤집힐 수 있다. 그러면 그
// tailnet 을 쓰는 첫 연결이 "tailnet 을 모른다" 로 실패한다.
func TestRouterAppliesTailnetConfigBeforeLaterFrames(t *testing.T) {
	core := &stubCoreRuntime{
		configureRelease: make(chan struct{}),
		connectDone:      make(chan struct{}),
	}
	router := newFrameRouter(core, newEventWriter())
	connectDone := core.connectDone

	router.route(controlFrame(t, protocol.Request{
		ID:   "configure-1",
		Type: protocol.CommandTailnetConfigure,
		Payload: mustMarshal(t, protocol.TailnetConfigurePayload{
			Configs: []protocol.TailnetConfigPayload{{ID: "tailnet-1"}},
		}),
	}))
	router.route(controlFrame(t, protocol.Request{
		ID:        "connect-1",
		Type:      protocol.CommandConnect,
		SessionID: "session-1",
		Payload:   mustMarshal(t, protocol.ConnectPayload{Host: "192.168.200.37", Port: 22}),
	}))

	// 설정이 아직 안 끝났으므로 연결도 시작되지 않아야 한다.
	select {
	case <-connectDone:
		t.Fatal("설정이 끝나기 전에 연결이 시작됐다")
	case <-time.After(50 * time.Millisecond):
	}

	close(core.configureRelease)
	awaitClosed(t, "연결", connectDone)

	core.mu.Lock()
	sawConfig := core.connectSawConfig
	core.mu.Unlock()
	if !sawConfig {
		t.Fatal("연결이 tailnet 설정보다 먼저 실행됐다")
	}
}

// 정지는 그것이 끊어야 할 작업 뒤에 줄 서면 안 된다.
//
// 실기기 증상: 포워딩이 `starting` 인 동안 stop 이 여전히 무반응이었다. stop 은 start 와 같은
// 대상(endpoint)이라 같은 줄에 섰고, 그 줄의 앞에는 사람을 기다리는 start 가 있었다 — 순서 보존이
// 옳은 기본값이지만, **끊으러 온 명령**에는 예외가 필요하다.
func TestRouterStopReachesTheServiceWhileStartIsBlocked(t *testing.T) {
	core := &stubCoreRuntime{
		forwardStarted: make(chan struct{}),
		forwardRelease: make(chan struct{}),
		forwardStopped: make(chan struct{}),
	}
	defer core.releaseForward()
	router := newFrameRouter(core, newEventWriter())

	router.route(controlFrame(t, protocol.Request{
		ID:         "forward-1",
		Type:       protocol.CommandPortForwardStart,
		EndpointID: "rule-1",
		Payload:    mustMarshal(t, protocol.PortForwardStartPayload{Host: "192.168.200.37", Port: 22}),
	}))
	awaitClosed(t, "포워딩 시작", core.forwardStarted)

	router.route(controlFrame(t, protocol.Request{
		ID:         "stop-1",
		Type:       protocol.CommandPortForwardStop,
		EndpointID: "rule-1",
	}))

	// 진행 중 작업이 끊겨서(취소) start 가 끝나고, 곧바로 stop 이 실행돼야 한다.
	awaitClosed(t, "포워딩 정지", core.forwardStopped)
}

// 세션 종료도 같은 이유로 진행 중 연결을 먼저 끊어야 한다.
//
// 실기기 증상: 붙는 중에 탭을 닫으면 탭은 사라지는데 **연결 작업은 백그라운드에 그대로 남았다**.
// 종료 명령이 연결과 같은 세션 줄에 서 있었기 때문이다.
func TestRouterDisconnectCancelsAnInFlightConnect(t *testing.T) {
	core := &stubCoreRuntime{}
	router := newFrameRouter(core, newEventWriter())

	router.route(controlFrame(t, protocol.Request{
		ID:        "disconnect-1",
		Type:      protocol.CommandDisconnect,
		SessionID: "session-1",
	}))

	for attempt := 0; attempt < 300; attempt += 1 {
		core.mu.Lock()
		cancelled := append([]string(nil), core.cancelledInFlight...)
		core.mu.Unlock()
		if len(cancelled) == 1 && cancelled[0] == "session-1" {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("종료가 진행 중 연결을 끊지 않았다")
}
