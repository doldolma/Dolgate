package runtime

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"

	"dolssh/services/ssh-core/internal/sshconn"
	"dolssh/services/ssh-core/internal/tailnet"
)

// ErrTailnetMismatch 는 설정이 가리키는 tailnet 이 아닌 곳에 붙었을 때다.
var ErrTailnetMismatch = errors.New("tailnet: connected to a different tailnet")

// TailnetRoute 는 이 연결을 어느 tailnet 으로 보낼지다.
type TailnetRoute struct {
	// ID 가 비면 tailnet 을 쓰지 않는다(일반 네트워크).
	ID string
	// ExpectedName 은 설정에 박아 둔 tailnet 이름이다. 비어 있지 않으면 실제로 붙은 곳과
	// 대조해서 다르면 연결을 거부한다.
	//
	// 이 검사가 필요한 이유: Tailscale 기본 서버는 설정에 서버 주소조차 없어서, 다른 계정으로
	// 로그인하면 조용히 다른 tailnet 에 붙는다. 그 tailnet 에 같은 이름의 다른 머신이 있으면
	// 엉뚱한 곳으로 연결을 시도하게 된다. 호스트 키 검증이 마지막에 막아 주겠지만, 거기까지
	// 가기 전에 끊는 것이 맞다.
	ExpectedName string
}

// tailnetDial 은 이 경로로 raw 연결을 여는 함수를 만든다. 경로가 비어 있으면 nil 을 돌려주고,
// 그 경우 sshconn 은 평소처럼 직접 TCP 로 나간다.
//
// 리스는 여기서 잡고 **반환된 conn 이 닫힐 때** 놓는다. 호출부가 리스를 들고 다니지 않아도
// 되는 이유다 — 세션 매니저들은 이미 client/conn 을 닫고 있어서 수명이 저절로 맞는다. 리스를
// 따로 관리하면 종료 경로(정상 종료·채널 끊김·프로세스 죽음)마다 해제를 빠뜨릴 자리가 생긴다.
func (runtime *Runtime) tailnetDial(route TailnetRoute) (sshconn.DialFunc, error) {
	id := strings.TrimSpace(route.ID)
	if id == "" {
		return nil, nil
	}
	if runtime.tailnets == nil {
		return nil, errors.New("tailnet support is not enabled")
	}

	return func(ctx context.Context, network, address string) (net.Conn, error) {
		lease, err := runtime.tailnets.Acquire(id)
		if err != nil {
			return nil, err
		}

		// 여기서 실패하면 리스를 반드시 놓아야 한다. 안 놓으면 노드가 영원히 유예에 들어가지
		// 못해 계속 떠 있는다.
		conn, err := dialThroughLease(ctx, lease, route.ExpectedName, network, address)
		if err != nil {
			lease.Release()
			return nil, err
		}
		return &leasedConn{Conn: conn, lease: lease}, nil
	}, nil
}

func dialThroughLease(
	ctx context.Context,
	lease *tailnet.Lease,
	expectedName string,
	network string,
	address string,
) (net.Conn, error) {
	// 끊어 뒀거나 유휴로 내려간 노드일 수 있다. 올리지 않으면 붙지 않는 노드를 기다린다.
	if err := lease.Node.Up(ctx); err != nil {
		return nil, err
	}

	status, err := lease.Node.Status(ctx)
	if err != nil {
		return nil, err
	}
	// 인증이 남은 노드는 여기서 끊는다. 그대로 dial 하면 tsnet 이 인증이 끝나기를 기다리다
	// 예산을 다 쓰고 타임아웃으로 실패하는데, 사용자는 무엇을 해야 할지 알 수 없다. 인증은
	// 설정 화면의 흐름이 할 일이다(브라우저를 열고 진행 상태를 보여 준다).
	if err := assertTailnetAuthenticated(status); err != nil {
		return nil, err
	}
	if err := assertTailnetIdentity(status, expectedName); err != nil {
		return nil, err
	}
	return lease.Node.Dial(ctx, network, address)
}

// ErrTailnetNeedsAuth 는 노드 등록이 끝나지 않았을 때다. 호스트 연결 경로에서는 기다리지 않고
// 곧바로 안내한다 — 인증은 설정 화면에서 해야 한다.
var ErrTailnetNeedsAuth = errors.New(
	"tailnet: this tailnet is not connected yet — connect it in settings first",
)

// ErrTailnetNeedsApproval 은 등록은 됐지만 관리자 인가가 남았을 때다.
var ErrTailnetNeedsApproval = errors.New(
	"tailnet: this node is waiting for administrator approval",
)

func assertTailnetAuthenticated(status tailnet.Status) error {
	switch status.State {
	case tailnet.StateNeedsAuth:
		return ErrTailnetNeedsAuth
	case tailnet.StateNeedsApproval:
		return ErrTailnetNeedsApproval
	default:
		return nil
	}
}

// assertTailnetIdentity 는 붙은 곳이 설정이 가리키는 tailnet 인지 확인한다.
//
// 이름을 모르면(설정이 예전 것이거나 컨트롤 플레인이 안 알려 주면) 통과시킨다. 모른다는 것을
// 이유로 연결을 막으면, 이름을 기록하기 전에 만든 설정이 전부 못 쓰게 된다.
func assertTailnetIdentity(status tailnet.Status, expectedName string) error {
	expected := strings.TrimSpace(expectedName)
	if expected == "" {
		return nil
	}

	actual := strings.TrimSpace(status.TailnetName)
	if actual == "" || actual == expected {
		return nil
	}
	return fmt.Errorf("%w: expected %q, connected to %q", ErrTailnetMismatch, expected, actual)
}

// leasedConn 은 닫힐 때 tailnet 노드 리스를 놓는 conn 이다.
//
// 리스를 func() 이 아니라 *tailnet.Lease 로 들고 있는 이유가 있다. Close 는 여러 번 불릴 수
// 있는데(핸드셰이크 실패 경로와 정상 종료가 겹칠 때), 두 번 풀면 아직 쓰는 중인 노드가
// 내려간다. Lease.Release 는 그것을 위해 이미 멱등이므로 여기서 또 막지 않는다 — 타입으로
// 그 보장을 드러내 두면, 나중에 멱등하지 않은 해제 함수가 끼어들 수 없다.
type leasedConn struct {
	net.Conn
	lease *tailnet.Lease
}

func (c *leasedConn) Close() error {
	err := c.Conn.Close()
	c.lease.Release()
	return err
}
