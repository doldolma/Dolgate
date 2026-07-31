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
		conn, err := runtime.dialThroughLease(ctx, id, &lease, route.ExpectedName, network, address)
		if err != nil {
			lease.Release()
			return nil, err
		}
		return &leasedConn{Conn: conn, lease: lease}, nil
	}, nil
}

func (runtime *Runtime) dialThroughLease(
	ctx context.Context,
	id string,
	lease **tailnet.Lease,
	expectedName string,
	network string,
	address string,
) (net.Conn, error) {
	// 끊어 뒀거나 유휴로 내려간 노드일 수 있다. 올리지 않으면 붙지 않는 노드를 기다린다.
	if err := (*lease).Node.Up(ctx); err != nil {
		return nil, err
	}
	probeTailnetIdentity(ctx, (*lease).Node)

	status, err := (*lease).Node.Status(ctx)
	if err != nil {
		return nil, err
	}
	// 연결 준비 단계를 거치지 않고 transport dial 로 바로 들어오는 소비자도 같은 자동 복구를
	// 받아야 한다. 이 판단은 SSH 결과가 아니라 tailnet control 상태만 사용한다.
	if status.IdentityInvalid {
		if _, err := runtime.replaceInvalidIdentity(ctx, id, lease); err != nil {
			return nil, err
		}
		status, err = (*lease).Node.Status(ctx)
		if err != nil {
			return nil, err
		}
	}
	// dial 직전 안전망. 관문(Connected)과 다른 질문을 묻는다 — "확실히 막혔나".
	//
	// 판정은 tailnet.Status 에만 있다. 여기서 running·만료·인증을 다시 조합하지 않는다.
	if err := assertTailnetNotBlocked(status); err != nil {
		return nil, err
	}
	if err := assertTailnetIdentity(status, expectedName); err != nil {
		return nil, err
	}
	return (*lease).Node.Dial(ctx, network, address)
}

// ErrTailnetLoginRejected 는 컨트롤 플레인이 로그인을 거부했을 때다(잘못된 auth key 등).
//
// 다른 이유들과 성질이 다르다 — 기다리거나 다시 시도해서 풀리지 않고, 사람이 설정을 고쳐야 한다.
// 그래서 이유를 함께 붙여 올린다.
var ErrTailnetLoginRejected = errors.New("tailnet: the control plane rejected this login")

// ErrTailnetNeedsAuth 는 노드 등록이 끝나지 않았을 때다. 호스트 연결 경로에서는 기다리지 않고
// 곧바로 안내한다 — 인증은 설정 화면에서 해야 한다.
var ErrTailnetNeedsAuth = errors.New(
	"tailnet: this tailnet is not connected yet — connect it in settings first",
)

// ErrTailnetNeedsApproval 은 등록은 됐지만 관리자 인가가 남았을 때다.
var ErrTailnetNeedsApproval = errors.New(
	"tailnet: this node is waiting for administrator approval",
)

// ErrTailnetExpired 는 노드 등록이 만료됐을 때다.
var ErrTailnetExpired = errors.New(
	"tailnet: this tailnet's node registration has expired",
)

// ErrTailnetIdentityInvalid 는 자동 교체 뒤에도 컨트롤 플레인이 노드 identity 를 거부할 때다.
var ErrTailnetIdentityInvalid = errors.New(
	"tailnet: the control plane no longer recognizes this node identity",
)

// assertTailnetNotBlocked 는 확정적으로 막힌 상태면 그 이유로 끊는다.
//
// 판정 자체는 tailnet.Status.BlockedReason 한 곳에 있고, 여기서는 그 결과를 에러로 옮기기만 한다.
//
// BlockOffline 은 막지 않는다. 그것은 컨트롤 플레인 map poll 이 지금 열려 있지 않다는 뜻일 뿐이고,
// 데이터 플레인은 이미 받아 둔 넷맵으로 계속 통한다 — tailscale 자신도 이 상태를 8분이 지나서야
// 경고로 올리고(health 의 notInMapPoll, "peer reachability might degrade over time"), magicsock 은
// 컨트롤과 끊기면 DERP 홈을 바꾸지 않고 **유지한다**(피어가 변경을 알 수 없으므로). 여기서 막으면
// 실제로 통하는 연결을 시도조차 못 하게 된다.
//
// 낡은 넷맵으로 dial 하는 것이 위험하지도 않다 — 피어 키가 바뀌었으면 WireGuard 핸드셰이크가
// 실패할 뿐이고, 그 뒤에 호스트 키 검증이 또 있다. 못 가면 그 실패가 그대로 이유가 된다.
func assertTailnetNotBlocked(status tailnet.Status) error {
	switch status.BlockedReason() {
	case tailnet.BlockLoginFailed:
		return fmt.Errorf("%w: %s", ErrTailnetLoginRejected, status.LoginError)
	case tailnet.BlockNeedsAuth:
		return ErrTailnetNeedsAuth
	case tailnet.BlockNeedsApproval:
		return ErrTailnetNeedsApproval
	case tailnet.BlockExpired:
		return ErrTailnetExpired
	case tailnet.BlockIdentityInvalid:
		return ErrTailnetIdentityInvalid
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
