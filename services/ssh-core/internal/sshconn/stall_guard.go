package sshconn

import (
	"net"
	"sync"
	"time"
)

// HandshakeStallTimeout 은 핸드셰이크 중 **한 바이트도 움직이지 않는 것**을 얼마나 참을지다.
//
// TCPDialTimeout 과 값이 같지만 같은 상수를 쓰지 않는다 — 재는 대상이 다르다(연결 수립 vs 진행
// 중 정지). 한쪽을 조정할 때 다른 쪽이 따라 움직이면 안 된다.
//
// 10초인 근거: 키 교환은 몇 왕복이라 릴레이 경유로 RTT 가 300ms 여도 2초 안에 끝난다. 10초 동안
// 완전한 침묵은 어떤 정상 경로에서도 나오지 않는다.
const HandshakeStallTimeout = 10 * time.Second

// HandshakeApprovalTimeout 은 서버가 배너로 사람에게 할 일을 알린 뒤 기다려 주는 시간이다.
//
// 왜 무한이 아닌가: 사용자는 그동안 화면의 안내를 보고 있고 닫기로 즉시 취소할 수 있으니(ctx 취소가
// conn 을 닫는다) 무한 대기도 "보이지 않는 멈춤" 은 아니다. 그래도 상한을 두는 이유는 서버가 그
// 사이에 죽으면 소켓과 고루틴이 남기 때문이다. 브라우저를 열어 승인하고 돌아오는 데 5분이면 넉넉하다.
const HandshakeApprovalTimeout = 5 * time.Minute

// stallGuard 는 핸드셰이크가 조용히 멈추는 것을 실패로 바꾼다.
//
// **왜 필요한가:** `ssh.NewClientConn` 은 이미 열린 conn 을 받으므로 `ClientConfig.Timeout` 을
// 보지 않는다(그 값은 `ssh.Dial` 의 net.DialTimeout 에서만 쓰인다). TCP 는 붙었는데 그 뒤
// 핸드셰이크가 멈추면 **영원히 기다린다** — 화면에는 "SSH 연결" 단계에 앉은 채 오류도 뜨지 않는다.
// tailnet 릴레이 경유에서 실제로 그 상태를 겪었다.
//
// **절대 시간이 아니라 무응답 시간을 재는 이유:** NewClientConn 은 키 교환과 **인증**을 함께 한다.
// 우리 keyboard-interactive 콜백은 사람을 기다리므로(Warpgate 브라우저 승인·2FA) 몇 분이 정상이다.
// 그래서 사람을 기다리는 구간에는 Pause 로 시계를 멈춘다.
//
// 핸드셰이크가 성공하면 Release 로 감시를 끈다. 끄지 않으면 세션의 평소 읽기가 10초마다 끊긴다 —
// 세션 유지는 keepalive 가 담당한다.
//
// **점프 뒤의 홉에는 걸리지 않는다.** 그 홉의 conn 은 점프 연결 위의 SSH 채널이고, x/crypto 의
// chanConn.SetReadDeadline 은 언제나 "deadline not supported" 를 돌려준다. 그래서 아래 SetDeadline
// 은 조용히 실패하고 감시는 사실상 꺼진 상태가 된다 — 첫 홉(진짜 소켓, tailnet 포함)만 보호된다.
//
// 방치하는 이유: 그 구간이 멈춰도 사용자는 탭을 닫아 끊을 수 있고(ctx 취소가 conn 을 닫는다),
// 타이머로 대신 재면 멀쩡한 연결을 우리가 끊는 새 위험이 생긴다. 자동 실패가 없을 뿐 막다른 곳은
// 아니다. 바꾸려면 이 문단부터 지우면 된다.
type stallGuard struct {
	timeout time.Duration

	mu       sync.Mutex
	conn     net.Conn
	paused   int
	released bool
}

func newStallGuard(timeout time.Duration) *stallGuard {
	if timeout <= 0 {
		timeout = HandshakeStallTimeout
	}
	return &stallGuard{timeout: timeout}
}

// Wrap 은 감시할 conn 을 붙이고, 그 conn 을 감싼 것을 돌려준다. 다이얼이 끝난 뒤에 부른다 —
// 인증 방식은 다이얼보다 먼저 만들어지므로(resolveAuthMethods) 감시자와 conn 의 수명이 다르다.
func (g *stallGuard) Wrap(conn net.Conn) net.Conn {
	g.mu.Lock()
	g.conn = conn
	g.mu.Unlock()
	return &stallGuardConn{Conn: conn, guard: g}
}

// Pause 는 사람을 기다리는 동안 시계를 멈춘다. 중첩 호출을 허용한다(인증 단계가 여러 번 물을 수 있다).
func (g *stallGuard) Pause() {
	g.mu.Lock()
	g.paused++
	conn := g.conn
	g.mu.Unlock()
	if conn != nil {
		// 기다리는 동안 데드라인을 지운다. 사람이 답하기까지의 침묵은 정지가 아니다.
		_ = conn.SetDeadline(time.Time{})
	}
}

// Resume 은 Pause 와 짝이다. 마지막 Pause 가 풀리면 다시 감시한다.
func (g *stallGuard) Resume() {
	g.mu.Lock()
	if g.paused > 0 {
		g.paused--
	}
	g.mu.Unlock()
}

// Extend 는 남은 핸드셰이크 동안 참을 무응답 시간을 늘린다. 사람을 기다리는 구간에 쓴다.
//
// Pause 와 다른 점: Pause 는 우리가 사람의 답을 **직접 받고 있을 때**(keyboard-interactive) 쓴다 —
// 언제 끝나는지 우리가 안다. 여기는 서버가 딴 곳에서(브라우저) 승인을 기다리는 경우라 끝을 알 수
// 없으므로, 시계를 멈추는 대신 넉넉한 상한으로 바꾼다.
//
// 이미 걸려 있는 데드라인은 옛 한도로 잡혀 있다 — 지금 다시 걸어야 **이번** 대기부터 적용된다.
func (g *stallGuard) Extend(timeout time.Duration) {
	g.mu.Lock()
	if timeout > g.timeout {
		g.timeout = timeout
	}
	effective := g.timeout
	conn := g.conn
	active := !g.released && g.paused == 0
	g.mu.Unlock()
	if conn != nil && active {
		_ = conn.SetDeadline(time.Now().Add(effective))
	}
}

// Release 는 핸드셰이크가 끝난 뒤 감시를 끈다. 이후 데드라인을 걸지 않는다.
func (g *stallGuard) Release() {
	g.mu.Lock()
	g.released = true
	conn := g.conn
	g.mu.Unlock()
	if conn != nil {
		_ = conn.SetDeadline(time.Time{})
	}
}

// arm 은 다음 한 번의 읽기·쓰기에 데드라인을 건다. 감시 중이 아니면 아무것도 하지 않는다.
func (g *stallGuard) arm(conn net.Conn) {
	g.mu.Lock()
	active := !g.released && g.paused == 0
	timeout := g.timeout
	g.mu.Unlock()
	if !active {
		return
	}
	_ = conn.SetDeadline(time.Now().Add(timeout))
}

// stallGuardConn 은 읽기·쓰기마다 데드라인을 다시 건다.
//
// 연산 하나가 timeout 보다 오래 막히면 실패하므로, 결과적으로 "무응답 시간" 을 재는 것과 같다 —
// 바이트가 흐르면 다음 연산에서 데드라인이 새로 밀린다.
type stallGuardConn struct {
	net.Conn
	guard *stallGuard
}

func (c *stallGuardConn) Read(p []byte) (int, error) {
	c.guard.arm(c.Conn)
	return c.Conn.Read(p)
}

func (c *stallGuardConn) Write(p []byte) (int, error) {
	c.guard.arm(c.Conn)
	return c.Conn.Write(p)
}
