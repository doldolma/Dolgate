package main

import (
	"log"
	"sync"

	"dolssh/services/ssh-core/internal/protocol"
)

// logRouterf 는 배차 진단을 stderr 로 남긴다(stdout 은 프레임 채널이라 쓸 수 없다).
func logRouterf(format string, args ...any) {
	log.Printf("router: "+format, args...)
}

// laneDepthWarning 은 한 대상에 프레임이 이만큼 쌓이면 경고를 남긴다.
//
// 정상 사용에서는 한 대상에 동시에 몇 개가 겹칠 뿐이다. 이 숫자를 넘었다면 그 대상의 작업이
// 멈춰 있다는 뜻이고, 어느 대상인지 알면 조사가 짧아진다.
const laneDepthWarning = 32

// frameRouter 는 들어온 프레임을 대상별 줄에 세워 처리한다.
//
// **왜 필요한가:** 예전에는 stdin 을 읽는 그 고루틴이 핸들러까지 직접 실행했다. 핸들러 대부분이
// 네트워크 작업(포워딩 시작, SFTP 목록, 컨테이너 조회, 원격 키 설치…)을 그 자리에서 하므로, 그중
// 하나가 느려지면 **관계없는 요청 전부가 그 뒤에 줄을 섰다.** 실기기에서 OTP 호스트로 포워딩을
// 시작하면(사람의 답을 기다리는 동기 핸들러) 앱의 모든 기능이 함께 멈췄다 — SSH·SFTP·컨테이너·
// ECS·tailnet 조회까지. 게다가 그 답은 **다음 프레임**으로 오므로 영원히 서로를 기다렸다.
//
// **왜 프레임마다 자유 병렬이 아니라 대상별 줄인가:** 같은 세션의 명령은 순서가 의미를 갖는다
// (resize 뒤의 write, connect 뒤의 disconnect). 자유롭게 병렬로 돌리면 그 순서가 뒤집힌다.
// 대상별로 한 줄씩 세우면 **같은 대상은 순서 보존, 다른 대상은 병렬**이 된다.
//
// 프로세스는 그대로 하나다. tailnet 노드·SSH 클라이언트·SFTP 세션은 이 프로세스 안의 공유 상태라
// 프로세스를 쪼개면 재사용이 깨진다 — 나누는 것은 실행 흐름뿐이다.
type frameRouter struct {
	core   coreRuntime
	writer *eventWriter

	mu sync.Mutex
	// tails[scope] 는 그 대상의 마지막 프레임이 끝나면 닫히는 채널이다. 새 프레임은 그것을
	// 기다린 뒤 실행하므로, 큐 객체 없이 순서가 보존된다.
	tails map[string]chan struct{}
	depth map[string]int
	// barrier 는 "이 뒤에 온 프레임은 이것이 끝난 뒤에 실행" 을 뜻한다(tailnetConfigure).
	barrier <-chan struct{}
}

func newFrameRouter(core coreRuntime, writer *eventWriter) *frameRouter {
	return &frameRouter{
		core:   core,
		writer: writer,
		tails:  make(map[string]chan struct{}),
		depth:  make(map[string]int),
	}
}

// route 는 프레임을 그 대상의 줄 끝에 붙이고 곧바로 돌아온다. 읽기 고루틴은 절대 막히지 않는다.
func (router *frameRouter) route(frame protocol.Frame) {
	command := frameCommand(frame)

	// 대화형 인증 응답과 호스트 키 신뢰 응답은 줄을 서지 않는다.
	//
	// 이 프레임은 **자기가 답해야 할 작업**(연결·포워딩·프로브)이 진행 중일 때 온다. 그 작업과
	// 같은 줄에 세우면 답이 도착할 수 없어 교착이다. 처리 자체는 대기표에 값을 넣는 것뿐이고
	// (모든 서비스가 mutex + 논블로킹 전송이다) 배리어와도 무관하므로 여기서 즉시 처리한다.
	if command == protocol.CommandKeyboardInteractiveRespond ||
		command == protocol.CommandHostKeyTrustRespond {
		router.run(frame)
		return
	}

	// 끊으러 온 명령은 먼저 진행 중인 작업을 중단시킨다.
	//
	// 정지·종료는 자기가 끊어야 할 작업과 **같은 대상**이라 같은 줄에 선다. 순서 보존은 옳은
	// 기본값이지만(정지가 시작보다 먼저 실행되면 안 된다), 앞의 작업이 몇 분씩 기다리는 중이면
	// 정지는 영원히 자기 차례를 못 받는다 — 실기기에서 "stop 무반응", "탭은 닫혔는데 연결은
	// 백그라운드에 남음" 이 그 상태였다.
	//
	// 그래서 줄을 새치기하는 대신 **진행 중인 것을 여기서 끊는다.** 그러면 앞의 작업이 곧 끝나고,
	// 정지는 원래 순서대로 그 뒤에 실행된다. 끊을 것이 없으면 아무 일도 하지 않는다.
	if isCancelCommand(command) {
		router.core.CancelInFlight(frameSessionID(frame), frameEndpointID(frame))
	}

	scope := frameScope(frame, command)
	previous, done, depth := router.claim(scope)
	if depth >= laneDepthWarning {
		// 어느 대상이 밀려 있는지 남긴다. 값은 남기지 않는다(스코프 ID 는 우리 것이다).
		logRouterf("lane %s has %d frames waiting — something on it is stuck", scope, depth)
	}
	// 배리어 이후의 프레임은 배리어가 끝난 뒤에 실행한다. 리더가 아니라 이 고루틴이 기다리므로
	// 배차는 계속 진행된다.
	barrier := router.currentBarrier()
	if isBarrierCommand(command) {
		router.setBarrier(done)
	}

	go func() {
		defer router.release(scope, done)
		if barrier != nil {
			<-barrier
		}
		if previous != nil {
			<-previous
		}
		router.run(frame)
	}()
}

// claim 은 이 대상의 줄 끝을 잡는다. 앞 프레임의 완료 채널과 우리 완료 채널을 돌려준다.
func (router *frameRouter) claim(scope string) (previous <-chan struct{}, done chan struct{}, depth int) {
	router.mu.Lock()
	defer router.mu.Unlock()
	previous = router.tails[scope]
	done = make(chan struct{})
	router.tails[scope] = done
	router.depth[scope] += 1
	return previous, done, router.depth[scope]
}

// release 는 우리 차례를 끝내고, 뒤에 아무도 없으면 대상 항목을 지운다(맵이 무한히 자라지 않게).
func (router *frameRouter) release(scope string, done chan struct{}) {
	router.mu.Lock()
	router.depth[scope] -= 1
	if router.depth[scope] <= 0 {
		delete(router.depth, scope)
	}
	if router.tails[scope] == done {
		delete(router.tails, scope)
	}
	router.mu.Unlock()
	close(done)
}

func (router *frameRouter) currentBarrier() <-chan struct{} {
	router.mu.Lock()
	defer router.mu.Unlock()
	return router.barrier
}

func (router *frameRouter) setBarrier(done <-chan struct{}) {
	router.mu.Lock()
	router.barrier = done
	router.mu.Unlock()
}

// pending 은 지금 줄에 남아 있는 대상 수다(테스트에서 누수를 확인한다).
func (router *frameRouter) pending() int {
	router.mu.Lock()
	defer router.mu.Unlock()
	return len(router.tails)
}

// run 은 핸들러를 실행하고, 실패하면 예전과 같은 형태로 오류 이벤트를 올린다.
func (router *frameRouter) run(frame protocol.Frame) {
	if err := dispatchFrame(router.core, router.writer, frame); err != nil {
		eventType := protocol.EventError
		if isSFTPCommand(frame) {
			eventType = protocol.EventSFTPError
		} else if isContainersCommand(frame) {
			eventType = protocol.EventContainersError
		} else if isPortForwardCommand(frame) {
			eventType = protocol.EventPortForwardError
		}
		router.writer.emit(protocol.Event{
			Type:       eventType,
			RequestID:  frameRequestID(frame),
			SessionID:  frameSessionID(frame),
			EndpointID: frameEndpointID(frame),
			JobID:      frameJobID(frame),
			Payload: protocol.ErrorPayload{
				Message: err.Error(),
			},
		})
	}
}

// frameScope 는 이 프레임이 어느 대상에 속하는지다. 같은 값이면 같은 줄에 선다.
//
// 세션·엔드포인트·전송 작업은 각자의 줄을 갖는다. 어느 것도 없는 명령(tailnet 조회, 키 생성,
// 인증서 검사 등)은 하나의 전역 줄을 함께 쓴다 — 서로 순서를 지켜야 하는 것들이 섞여 있고
// 어차피 짧다.
func frameScope(frame protocol.Frame, command protocol.CommandType) string {
	if sessionID := frameSessionID(frame); sessionID != "" {
		return "session:" + sessionID
	}
	if endpointID := frameEndpointID(frame); endpointID != "" {
		return "endpoint:" + endpointID
	}
	if jobID := frameJobID(frame); jobID != "" {
		return "job:" + jobID
	}
	// 호스트 키 프로브는 사람에게 인증을 물을 수 있어 오래 걸린다. 전역 줄에 세우면 그동안
	// tailnet 조회 같은 짧은 요청이 함께 멈춘다. 요청마다 자기 줄을 준다.
	if command == protocol.CommandProbeHostKey {
		if requestID := frameRequestID(frame); requestID != "" {
			return "probe:" + requestID
		}
	}
	return "global"
}

// isCancelCommand 는 "진행 중인 것을 끊으러 온" 명령이다.
//
// 전송 일시정지·취소(sftpTransfer*)는 여기 없다. 전송 시작은 곧바로 반환하고 실제 복사는 자기
// 고루틴에서 돌기 때문에, 그 명령들은 이미 자기 차례를 바로 받는다.
func isCancelCommand(command protocol.CommandType) bool {
	switch command {
	case protocol.CommandDisconnect,
		protocol.CommandPortForwardStop,
		protocol.CommandSSMPortForwardStop,
		protocol.CommandSFTPDisconnect,
		protocol.CommandContainersDisconnect:
		return true
	default:
		return false
	}
}

// isBarrierCommand 는 "이 뒤에 온 프레임보다 먼저 끝나야 하는" 명령이다.
//
// tailnet 설정이 그렇다. 설정은 응답을 기다리지 않고 보내지는데(코어가 뜰 때 한 번), 그 설정을
// 쓰는 첫 연결이 설정보다 먼저 실행되면 "tailnet 을 모른다" 로 실패한다. 단일 줄 시절에는 우연히
// 지켜졌던 순서다.
func isBarrierCommand(command protocol.CommandType) bool {
	return command == protocol.CommandTailnetConfigure
}

// frameCommand 는 제어 프레임의 명령 종류다. 스트림 프레임이면 빈 값이다.
func frameCommand(frame protocol.Frame) protocol.CommandType {
	if frame.Kind != protocol.FrameKindControl {
		return ""
	}
	var request protocol.Request
	if err := protocol.DecodeControlFrame(frame, &request); err != nil {
		return ""
	}
	return request.Type
}
