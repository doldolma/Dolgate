package tailnetservice

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"time"

	"dolssh/services/ssh-core/internal/sshconn"
	"dolssh/services/ssh-core/pkg/coretypes"
)

// forwardPrepareTimeout 은 포워드를 열기 전 노드를 올리는 데 기다리는 시간이다.
//
// 데스크톱은 이 요청에 30초를 준다. 그보다 짧게 잡아 이유가 있는 실패로 돌려준다 — 요청
// 타임아웃으로 끝나면 "왜 안 되는지" 가 남지 않는다.
const forwardPrepareTimeout = 20 * time.Second

// ForwardTarget 은 tailnet 안에서 이을 곳이다.
type ForwardTarget struct {
	Route TailnetRoute
	// Host 는 tailnet 안의 이름이나 주소다(MagicDNS 이름 포함).
	Host string
	Port int
}

// Forward 는 열려 있는 로컬 포워드 하나다.
type Forward struct {
	// Address 는 호출부가 붙을 곳이다(`127.0.0.1:<port>`). 포트는 OS 가 골라 준다.
	Address string
}

// forwarder 는 리스너 하나와 그 위에서 받은 연결들을 들고 있다.
type forwarder struct {
	listener net.Listener
	cancel   context.CancelFunc

	mu    sync.Mutex
	conns map[net.Conn]struct{}
}

// OpenForward 는 tailnet 안의 한 곳으로만 이어 주는 로컬 리스너를 연다.
//
// 왜 이렇게 하는가: RDP 코어는 Rust 라서 tsnet 을 쓸 수 없다. 여기서 tailnet 으로 이어 주는
// 로컬 주소를 만들어 주면, 그쪽은 평범한 TCP 로 붙기만 하면 된다. SSH 홉이 없으므로 기존
// 포워딩(SSH 클라이언트를 거치는)보다 단순하다.
//
// **`127.0.0.1` 에만 바인딩한다.** 다른 주소에 열면 같은 네트워크의 다른 기기가 이 포워드로
// tailnet 안에 들어올 수 있다 — 인증도 없는 우회로가 된다.
func (runtime *Service) OpenForward(id string, target ForwardTarget) (*Forward, error) {
	host := strings.TrimSpace(target.Host)
	if host == "" {
		return nil, errors.New("tailnet forward: target host is required")
	}
	if target.Port <= 0 || target.Port > 65535 {
		return nil, fmt.Errorf("tailnet forward: invalid target port %d", target.Port)
	}

	dial, err := runtime.Dial(target.Route)
	if err != nil {
		return nil, err
	}
	if dial == nil {
		// 경로가 비어 있다. 포워드를 열어 줘도 일반 네트워크로 나가므로 의미가 없고, 호출부는
		// tailnet 을 쓰는 줄 알고 붙는다.
		return nil, errors.New("tailnet forward: no tailnet route")
	}

	// 노드를 먼저 올린다.
	//
	// 리스너를 먼저 열면 호출부는 붙을 수 있는 줄 알고 붙는데, 그 시점에 노드가 아직 로그인·
	// 동기화 중이면 tailnet 으로 나가는 dial 이 그 안에서 기다린다 — 화면은 붙은 것처럼 보이고
	// 아무 일도 일어나지 않는다. SSH 는 같은 노드를 프로세스 안에서 직접 쓰면서 준비될 때까지
	// 기다리므로 이 문제가 없다. 여기서도 같은 순서로 맞춘다.
	//
	// 실패는 여기서 이유와 함께 올라간다 — 리스너를 열고 나면 그 이유를 전할 길이 없다.
	prepareCtx, cancelPrepare := context.WithTimeout(context.Background(), forwardPrepareTimeout)
	defer cancelPrepare()
	if err := runtime.prepareRoute(prepareCtx, target.Route); err != nil {
		return nil, fmt.Errorf("tailnet forward: %w", err)
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("tailnet forward: listen: %w", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	entry := &forwarder{
		listener: listener,
		cancel:   cancel,
		conns:    make(map[net.Conn]struct{}),
	}

	runtime.forwardMu.Lock()
	if runtime.forwards == nil {
		runtime.forwards = make(map[string]*forwarder)
	}
	previous := runtime.forwards[id]
	runtime.forwards[id] = entry
	runtime.forwardMu.Unlock()

	// 같은 id 로 다시 열면 앞의 것을 닫는다. 재연결이 그렇게 도는데, 안 닫으면 리스너가 쌓여
	// tailnet 을 향한 구멍이 계속 늘어난다.
	if previous != nil {
		previous.close()
	}

	address := listener.Addr().String()
	go entry.serve(ctx, dial, net.JoinHostPort(host, fmt.Sprintf("%d", target.Port)))

	return &Forward{Address: address}, nil
}

// TailnetForwardOpen 은 포워드를 열고 로컬 주소를 이벤트로 알린다.
func (runtime *Service) TailnetForwardOpen(
	requestID string,
	payload coretypes.TailnetForwardOpenPayload,
) error {
	forward, err := runtime.OpenForward(payload.ID, ForwardTarget{
		Route: TailnetRoute{ID: payload.TailnetID, ExpectedName: payload.TailnetName},
		Host:  payload.Host,
		Port:  payload.Port,
	})
	if err != nil {
		return err
	}

	runtime.emitEvent(coretypes.Event{
		Type:      coretypes.EventTailnetForwardOpened,
		RequestID: requestID,
		Payload: coretypes.TailnetForwardOpenedPayload{
			ID:      payload.ID,
			Address: forward.Address,
		},
	})
	return nil
}

// TailnetForwardClose 는 포워드를 닫는다. 없는 id 여도 오류가 아니다 — 정리는 여러 경로에서
// 불릴 수 있고(세션 종료·재연결·프로세스 종료), 없으면 이미 닫힌 것이다.
func (runtime *Service) TailnetForwardClose(payload coretypes.TailnetForwardClosePayload) error {
	runtime.CloseForward(payload.ID)
	return nil
}

// CloseForward 는 이 포워드를 닫는다. 없으면 아무 일도 하지 않는다.
//
// 세션이 끝나면 반드시 불러야 한다. 남겨 두면 tailnet 으로 이어지는 리스너가 계속 살아 있다.
func (runtime *Service) CloseForward(id string) {
	runtime.forwardMu.Lock()
	entry := runtime.forwards[id]
	delete(runtime.forwards, id)
	runtime.forwardMu.Unlock()

	if entry != nil {
		entry.close()
	}
}

// shutdownForwards 는 프로세스를 내릴 때 남은 포워드를 모두 닫는다.
func (runtime *Service) shutdownForwards() {
	runtime.forwardMu.Lock()
	entries := make([]*forwarder, 0, len(runtime.forwards))
	for _, entry := range runtime.forwards {
		entries = append(entries, entry)
	}
	runtime.forwards = nil
	runtime.forwardMu.Unlock()

	for _, entry := range entries {
		entry.close()
	}
}

func (f *forwarder) serve(ctx context.Context, dial sshconn.DialFunc, target string) {
	for {
		local, err := f.listener.Accept()
		if err != nil {
			// 닫혔거나 더 받을 수 없다. 여기서 끝낸다 — 실패한 Accept 를 반복하면 바쁜 루프가 된다.
			return
		}
		go f.pipe(ctx, dial, target, local)
	}
}

func (f *forwarder) pipe(ctx context.Context, dial sshconn.DialFunc, target string, local net.Conn) {
	f.track(local)
	defer f.forget(local)

	remote, err := dial(ctx, "tcp", target)
	if err != nil {
		// tailnet 이 내려갔거나 대상이 없다. 이 연결만 끊는다 — 붙는 쪽이 그것을 연결 실패로
		// 보고, 자동 재연결이 그 위에서 판단한다.
		_ = local.Close()
		return
	}
	f.track(remote)
	defer f.forget(remote)

	done := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(remote, local)
		// 한쪽이 끝나면 반대쪽 읽기도 풀어 준다. 안 그러면 절반만 닫힌 연결이 영원히 남는다.
		_ = remote.Close()
		done <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(local, remote)
		_ = local.Close()
		done <- struct{}{}
	}()

	<-done
	<-done
}

func (f *forwarder) track(conn net.Conn) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.conns != nil {
		f.conns[conn] = struct{}{}
	}
}

func (f *forwarder) forget(conn net.Conn) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.conns, conn)
}

func (f *forwarder) close() {
	f.cancel()
	_ = f.listener.Close()

	f.mu.Lock()
	conns := make([]net.Conn, 0, len(f.conns))
	for conn := range f.conns {
		conns = append(conns, conn)
	}
	f.conns = nil
	f.mu.Unlock()

	// 리스너만 닫으면 이미 붙어 있는 연결은 그대로 살아 tailnet 을 계속 쓴다. 닫는다는 것은
	// 그 경로를 끊는다는 뜻이어야 한다.
	for _, conn := range conns {
		_ = conn.Close()
	}
}
