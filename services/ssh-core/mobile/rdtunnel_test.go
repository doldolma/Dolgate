package mobile

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"dolssh/services/ssh-core/mobile/internal/sshtest"
	"dolssh/services/ssh-core/pkg/coretypes"
)

// fakeDialer connects to a real TCP listener (the fake VNC/RDP target).
type fakeDialer struct {
	targetAddr string
}

func (d *fakeDialer) DialTarget(ctx context.Context) (net.Conn, error) {
	var dialer net.Dialer
	return dialer.DialContext(ctx, "tcp", d.targetAddr)
}

type failingDialer struct{ err error }

func (d *failingDialer) DialTarget(context.Context) (net.Conn, error) {
	return nil, d.err
}

// startFakeTarget opens a TCP listener that echoes back everything it receives.
func startFakeTarget(t *testing.T) (addr string, stop func()) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	ctx, cancel := context.WithCancel(context.Background())

	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			wg.Add(1)
			go func() {
				defer wg.Done()
				defer conn.Close()
				buf := make([]byte, 4096)
				for {
					select {
					case <-ctx.Done():
						return
					default:
					}
					n, err := conn.Read(buf)
					if n > 0 {
						_, _ = conn.Write(buf[:n])
					}
					if err != nil {
						return
					}
				}
			}()
		}
	}()

	return listener.Addr().String(), func() {
		cancel()
		_ = listener.Close()
		wg.Wait()
	}
}

func authenticateTunnel(t *testing.T, conn net.Conn, tunnel *RDTunnel) {
	t.Helper()
	if tunnel.AuthToken() == "" {
		t.Fatal("expected loopback tunnel auth token")
	}
	if _, err := io.WriteString(conn, rdTunnelAuthPrefix+tunnel.AuthToken()+"\n"); err != nil {
		t.Fatal(err)
	}
}

func TestRDTunnelDirect(t *testing.T) {
	engine := NewEngine()
	defer engine.CloseAllRDTunnels()

	tunnel, err := engine.OpenRDTunnelDirect("test-direct", "10.0.0.5", 5900)
	if err != nil {
		t.Fatal(err)
	}
	if tunnel.Host() != "10.0.0.5" {
		t.Errorf("expected host 10.0.0.5, got %s", tunnel.Host())
	}
	if tunnel.Port() != 5900 {
		t.Errorf("expected port 5900, got %d", tunnel.Port())
	}
	if tunnel.Transport() != int(RDTunnelDirect) {
		t.Errorf("expected transport direct, got %d", tunnel.Transport())
	}
	if err := tunnel.Close(); err != nil {
		t.Fatal(err)
	}
	// Idempotent close.
	if err := tunnel.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestRDTunnelRejectsDuplicateIDWithoutReplacingOriginal(t *testing.T) {
	engine := NewEngine()
	defer engine.CloseAllRDTunnels()

	original, err := engine.OpenRDTunnelDirect("duplicate", "10.0.0.5", 5900)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := engine.OpenRDTunnelDirect("duplicate", "10.0.0.6", 5901); !errors.Is(err, errRDTunnelIDExists) {
		t.Fatalf("expected duplicate ID error, got %v", err)
	}
	if original.closed.Load() {
		t.Fatal("duplicate registration closed the original tunnel")
	}
	if err := engine.CloseRDTunnel("duplicate"); err != nil {
		t.Fatal(err)
	}
	if !original.closed.Load() {
		t.Fatal("registry no longer owned the original tunnel")
	}
}

func TestRDTunnelLoopback(t *testing.T) {
	targetAddr, stop := startFakeTarget(t)
	defer stop()

	engine := NewEngine()
	defer engine.CloseAllRDTunnels()

	dialer := &fakeDialer{targetAddr: targetAddr}
	tunnel, err := engine.OpenRDTunnel("test-loopback", RDTunnelTailscale, dialer)
	if err != nil {
		t.Fatal(err)
	}
	if tunnel.Host() != "127.0.0.1" {
		t.Fatalf("expected 127.0.0.1, got %s", tunnel.Host())
	}
	if tunnel.Port() <= 0 {
		t.Fatal("expected ephemeral port > 0")
	}

	// Connect to the tunnel.
	addr := fmt.Sprintf("127.0.0.1:%d", tunnel.Port())
	conn, err := net.DialTimeout("tcp", addr, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	authenticateTunnel(t, conn, tunnel)

	msg := []byte("VNC protocol init")
	if _, err := conn.Write(msg); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, len(msg))
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatal(err)
	}
	if string(buf) != string(msg) {
		t.Errorf("echo mismatch: got %q", buf)
	}

	// Close tunnel.
	if err := engine.CloseRDTunnel("test-loopback"); err != nil {
		t.Fatal(err)
	}
}

func TestOpenRDTunnelSurfacesInitialTargetDialError(t *testing.T) {
	engine := NewEngine()
	defer engine.CloseAllRDTunnels()

	want := errors.New("forward to 127.0.0.1:5901: connection refused")
	_, err := engine.OpenRDTunnel(
		"test-initial-dial-error",
		RDTunnelSSH,
		&failingDialer{err: want},
	)
	if !errors.Is(err, want) {
		t.Fatalf("expected target dial error, got %v", err)
	}
	if engine.rdTunnels.remove("test-initial-dial-error") != nil {
		t.Fatal("failed target dial registered a tunnel")
	}
}

func TestRDTunnelForwardsInitialRFBVersionBanner(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	serverDone := make(chan struct{})
	go func() {
		defer close(serverDone)
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		defer conn.Close()
		_, _ = io.WriteString(conn, "RFB 003.008\n")
		_, _ = io.Copy(io.Discard, conn)
	}()

	engine := NewEngine()
	tunnel, err := engine.OpenRDTunnel(
		"test-rfb-banner",
		RDTunnelSSH,
		&fakeDialer{targetAddr: listener.Addr().String()},
	)
	if err != nil {
		t.Fatal(err)
	}

	local, err := net.DialTimeout(
		"tcp",
		fmt.Sprintf("127.0.0.1:%d", tunnel.Port()),
		2*time.Second,
	)
	if err != nil {
		t.Fatal(err)
	}
	authenticateTunnel(t, local, tunnel)
	banner := make([]byte, 12)
	if _, err := io.ReadFull(local, banner); err != nil {
		t.Fatalf("read RFB banner: %v", err)
	}
	if string(banner) != "RFB 003.008\n" {
		t.Fatalf("unexpected RFB banner %q", banner)
	}

	_ = local.Close()
	_ = engine.CloseRDTunnel("test-rfb-banner")
	_ = listener.Close()
	select {
	case <-serverDone:
	case <-time.After(2 * time.Second):
		t.Fatal("fake RFB server did not stop")
	}
}

func TestOpenRemoteDesktopTunnelSSHForwardsRFBVersionBanner(t *testing.T) {
	target, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	targetDone := make(chan struct{})
	go func() {
		defer close(targetDone)
		conn, acceptErr := target.Accept()
		if acceptErr != nil {
			return
		}
		defer conn.Close()
		_, _ = io.WriteString(conn, "RFB 003.008\n")
		_, _ = io.Copy(io.Discard, conn)
	}()
	_, targetPortText, err := net.SplitHostPort(target.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	targetPort, err := strconv.Atoi(targetPortText)
	if err != nil {
		t.Fatal(err)
	}

	gateway, err := sshtest.NewServerWithOptions(sshtest.Options{AllowDirectTCPIP: true})
	if err != nil {
		t.Fatal(err)
	}
	defer gateway.Close()

	engine := NewEngine()
	defer engine.CloseAllRDTunnels()
	request, err := json.Marshal(map[string]any{
		"id":                   "rd-ssh-rfb",
		"host":                 "127.0.0.1",
		"port":                 gateway.Port(),
		"transport":            "ssh",
		"username":             sshtest.User,
		"authType":             "password",
		"password":             sshtest.Password,
		"trustedHostKeyBase64": gateway.HostKeyBase64(),
		"targetHost":           "127.0.0.1",
		"targetPort":           targetPort,
	})
	if err != nil {
		t.Fatal(err)
	}
	resultJSON, err := engine.OpenRemoteDesktopTunnel(string(request))
	if err != nil {
		t.Fatalf("open SSH Remote Desktop tunnel: %v", err)
	}
	var result rdTunnelResult
	if err := json.Unmarshal([]byte(resultJSON), &result); err != nil {
		t.Fatal(err)
	}

	local, err := net.DialTimeout(
		"tcp",
		net.JoinHostPort(result.Host, strconv.Itoa(result.Port)),
		2*time.Second,
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(local, rdTunnelAuthPrefix+result.AuthToken+"\n"); err != nil {
		t.Fatal(err)
	}
	banner := make([]byte, 12)
	if _, err := io.ReadFull(local, banner); err != nil {
		t.Fatalf("read RFB banner over SSH tunnel: %v", err)
	}
	if string(banner) != "RFB 003.008\n" {
		t.Fatalf("unexpected RFB banner %q", banner)
	}

	_ = local.Close()
	_ = engine.CloseRemoteDesktopTunnel(result.TunnelID)
	_ = target.Close()
	select {
	case <-targetDone:
	case <-time.After(2 * time.Second):
		t.Fatal("fake VNC target did not stop")
	}
}

func TestRDTunnelRejectsInvalidLoopbackToken(t *testing.T) {
	targetAddr, stop := startFakeTarget(t)
	defer stop()

	engine := NewEngine()
	defer engine.CloseAllRDTunnels()

	tunnel, err := engine.OpenRDTunnel(
		"test-auth",
		RDTunnelTailscale,
		&fakeDialer{targetAddr: targetAddr},
	)
	if err != nil {
		t.Fatal(err)
	}

	conn, err := net.DialTimeout(
		"tcp",
		fmt.Sprintf("127.0.0.1:%d", tunnel.Port()),
		2*time.Second,
	)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := io.WriteString(conn, rdTunnelAuthPrefix+fmt.Sprintf("%064x", 0)+"\n"); err != nil {
		t.Fatal(err)
	}
	if err := conn.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Read(make([]byte, 1)); err == nil {
		t.Fatal("expected invalid tunnel token to close the connection")
	}
}

func TestRDTunnelMaxConns(t *testing.T) {
	targetAddr, stop := startFakeTarget(t)
	defer stop()

	engine := NewEngine()
	defer engine.CloseAllRDTunnels()

	dialer := &fakeDialer{targetAddr: targetAddr}
	tunnel, err := engine.OpenRDTunnel("test-maxconns", RDTunnelSSH, dialer)
	if err != nil {
		t.Fatal(err)
	}

	addr := fmt.Sprintf("127.0.0.1:%d", tunnel.Port())
	// Open maxTunnelConns connections — all should succeed.
	conns := make([]net.Conn, 0, maxTunnelConns)
	for range maxTunnelConns {
		conn, err := net.DialTimeout("tcp", addr, 2*time.Second)
		if err != nil {
			t.Fatalf("expected connection to succeed: %v", err)
		}
		authenticateTunnel(t, conn, tunnel)
		conns = append(conns, conn)
	}
	// One more should be accepted at TCP level but immediately closed by the
	// tunnel (no echo).
	extra, err := net.DialTimeout("tcp", addr, 2*time.Second)
	if err == nil {
		// The tunnel accepts and closes; read should get EOF.
		buf := make([]byte, 1)
		_, err := extra.Read(buf)
		if err == nil {
			t.Error("expected read error on excess connection")
		}
		extra.Close()
	}

	for _, c := range conns {
		c.Close()
	}
	_ = tunnel.Close()
}

func TestOpenRemoteDesktopTunnelDirect(t *testing.T) {
	engine := NewEngine()
	defer engine.CloseAllRDTunnels()

	reqJSON, _ := json.Marshal(map[string]any{
		"id":        "rd-direct-1",
		"host":      "192.168.1.100",
		"port":      5900,
		"transport": "direct",
	})
	resultJSON, err := engine.OpenRemoteDesktopTunnel(string(reqJSON))
	if err != nil {
		t.Fatal(err)
	}
	var result rdTunnelResult
	if err := json.Unmarshal([]byte(resultJSON), &result); err != nil {
		t.Fatal(err)
	}
	if result.TunnelID != "rd-direct-1" {
		t.Errorf("expected tunnelId rd-direct-1, got %s", result.TunnelID)
	}
	if result.Host != "192.168.1.100" {
		t.Errorf("expected host 192.168.1.100, got %s", result.Host)
	}
	if result.Port != 5900 {
		t.Errorf("expected port 5900, got %d", result.Port)
	}
	if result.Transport != "direct" {
		t.Errorf("expected transport direct, got %s", result.Transport)
	}
	if err := engine.CloseRemoteDesktopTunnel("rd-direct-1"); err != nil {
		t.Fatal(err)
	}
}

func TestOpenRemoteDesktopTunnelSSMWrapsLocalForward(t *testing.T) {
	targetAddr, stop := startFakeTarget(t)
	defer stop()
	_, portText, err := net.SplitHostPort(targetAddr)
	if err != nil {
		t.Fatal(err)
	}
	localPort, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatal(err)
	}

	engine := NewEngine()
	defer engine.CloseAllRDTunnels()
	reqJSON, _ := json.Marshal(map[string]any{
		"id":        "rd-ssm-1",
		"host":      "i-1234",
		"port":      3389,
		"transport": "ssm",
		"localPort": localPort,
	})
	resultJSON, err := engine.OpenRemoteDesktopTunnel(string(reqJSON))
	if err != nil {
		t.Fatal(err)
	}
	var result rdTunnelResult
	if err := json.Unmarshal([]byte(resultJSON), &result); err != nil {
		t.Fatal(err)
	}
	if result.Transport != "ssm" || result.AuthToken == "" {
		t.Fatalf("expected authenticated SSM wrapper, got %#v", result)
	}
}

// --- SSH 터널 페이로드 조립 ---

// 터널용 SSH 접속이 tailnet 을 타야 한다. 이것이 빠지면 게이트웨이가 서브넷 라우터 뒤에 있을 때
// 폰의 일반 네트워크에서 그 주소를 찾다가 "no route to host" 로 죽는다 — 화면에는 tailnet 단계가
// 전부 초록인 채로.
func TestSSHPayloadCarriesTailnet(t *testing.T) {
	raw := `{
	  "id": "rd-1",
	  "host": "192.168.200.37",
	  "port": 22,
	  "transport": "ssh",
	  "username": "doyoung",
	  "authType": "password",
	  "password": "secret",
	  "tailnetId": "tn-abc",
	  "tailnetName": "doldolma.ts.net",
	  "targetHost": "127.0.0.1",
	  "targetPort": 5901
	}`
	var req rdTunnelRequest
	if err := json.Unmarshal([]byte(raw), &req); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	payload := sshPayloadFrom(req)
	if payload.TailnetID != "tn-abc" {
		t.Errorf("TailnetID = %q, want %q", payload.TailnetID, "tn-abc")
	}
	if payload.TailnetName != "doldolma.ts.net" {
		t.Errorf("TailnetName = %q, want %q", payload.TailnetName, "doldolma.ts.net")
	}
	// 게이트웨이 주소는 최상위 host/port 다 — VNC 대상은 targetHost/targetPort 로 따로 간다.
	if payload.Host != "192.168.200.37" || payload.Port != 22 {
		t.Errorf("게이트웨이 주소 = %s:%d, want 192.168.200.37:22", payload.Host, payload.Port)
	}
	// 이름이 겹치지 않는 필드는 원래도 멀쩡했다 — 회귀 여부를 가르는 대조군이다.
	if payload.Username != "doyoung" || payload.Password != "secret" {
		t.Errorf("자격증명이 유실됐다: %+v", payload)
	}
}

// 겹치는 이름이 늘어나도 사람이 기억하지 않게 한다.
//
// rdTunnelRequest 의 최상위 필드와 임베딩한 ConnectPayload 가 같은 json 이름을 쓰면, Go 는 얕은
// 쪽에만 값을 넣고 안쪽은 조용히 빈 채로 둔다. 그 목록을 여기서 직접 훑어, sshPayloadFrom 이
// 하나도 빠뜨리지 않는지 본다. ConnectPayload 에 겹치는 이름이 새로 생기면 이 테스트가 먼저 깨진다.
func TestSSHPayloadCarriesEveryShadowedField(t *testing.T) {
	shadowed := shadowedJSONNames()
	if len(shadowed) == 0 {
		t.Fatal("겹치는 이름이 하나도 없다 — 구조가 바뀌었으면 이 테스트도 다시 봐야 한다")
	}

	// 겹치는 이름마다 값을 하나씩 넣은 요청을 만든다.
	fields := map[string]any{"id": "rd-1", "transport": "ssh"}
	for name, kind := range shadowed {
		switch kind {
		case reflect.String:
			fields[name] = "값-" + name
		case reflect.Int:
			fields[name] = 4242
		default:
			t.Fatalf("%s: 다루지 않는 종류 %s — 이 테스트를 넓혀야 한다", name, kind)
		}
	}
	raw, err := json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	var req rdTunnelRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		t.Fatal(err)
	}

	payload := sshPayloadFrom(req)
	value := reflect.ValueOf(payload)
	payloadType := value.Type()
	for i := 0; i < payloadType.NumField(); i++ {
		name := jsonName(payloadType.Field(i))
		if _, ok := shadowed[name]; !ok {
			continue
		}
		if value.Field(i).IsZero() {
			t.Errorf(
				"%s(%s) 가 SSH 페이로드에 실리지 않았다 — sshPayloadFrom 에 되돌려 놓는 줄을 더해야 한다",
				payloadType.Field(i).Name, name,
			)
		}
	}
}

/** 최상위 필드와 ConnectPayload 가 같이 쓰는 json 이름 → 그 필드의 종류. */
func shadowedJSONNames() map[string]reflect.Kind {
	outer := map[string]struct{}{}
	requestType := reflect.TypeOf(rdTunnelRequest{})
	for i := 0; i < requestType.NumField(); i++ {
		field := requestType.Field(i)
		if field.Anonymous {
			continue
		}
		if name := jsonName(field); name != "" {
			outer[name] = struct{}{}
		}
	}

	shadowed := map[string]reflect.Kind{}
	payloadType := reflect.TypeOf(coretypes.ConnectPayload{})
	for i := 0; i < payloadType.NumField(); i++ {
		field := payloadType.Field(i)
		name := jsonName(field)
		if _, ok := outer[name]; ok && name != "" {
			shadowed[name] = field.Type.Kind()
		}
	}
	return shadowed
}

func jsonName(field reflect.StructField) string {
	tag := field.Tag.Get("json")
	if tag == "" || tag == "-" {
		return ""
	}
	return strings.Split(tag, ",")[0]
}
