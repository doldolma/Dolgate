package sshconn

import (
	"context"
	"errors"
	"net"
	"testing"
)

// 다섯 소비자(셸·tmux·mosh·SFTP·컨테이너·포워딩)가 모두 이 헬퍼를 지난다. 여기서 규칙이
// 하나면 한 경로만 조용히 일반 네트워크로 나가는 일이 없다.
func TestResolveTailnetDialWithoutARoute(t *testing.T) {
	called := false
	resolve := func(string, string) (DialFunc, error) {
		called = true
		return func(context.Context, string, string) (net.Conn, error) { return nil, nil }, nil
	}

	for _, id := range []string{"", "   "} {
		dial, err := ResolveTailnetDial(resolve, id, "gridwiz.com")
		if err != nil {
			t.Fatalf("ResolveTailnetDial(%q) error = %v", id, err)
		}
		if dial != nil {
			t.Errorf("ResolveTailnetDial(%q) returned a dialer", id)
		}
	}
	if called {
		t.Error("consulted the resolver for a host that does not use a tailnet")
	}
}

// tailnet 지원이 꺼진 빌드/환경이면 resolver 자체가 없다. 그때도 평소 경로로 나가야 한다.
func TestResolveTailnetDialWithoutAResolver(t *testing.T) {
	dial, err := ResolveTailnetDial(nil, "net-a", "gridwiz.com")
	if err != nil {
		t.Fatalf("ResolveTailnetDial() error = %v", err)
	}
	if dial != nil {
		t.Error("ResolveTailnetDial() returned a dialer without a resolver")
	}
}

func TestResolveTailnetDialPassesTheRouteThrough(t *testing.T) {
	var gotID, gotName string
	dial, err := ResolveTailnetDial(
		func(id, name string) (DialFunc, error) {
			gotID, gotName = id, name
			return func(context.Context, string, string) (net.Conn, error) { return nil, nil }, nil
		},
		"net-a",
		"gridwiz.com",
	)

	if err != nil {
		t.Fatalf("ResolveTailnetDial() error = %v", err)
	}
	if dial == nil {
		t.Fatal("ResolveTailnetDial() returned no dialer for a real route")
	}
	if gotID != "net-a" || gotName != "gridwiz.com" {
		t.Errorf("resolver got (%q, %q), want (net-a, gridwiz.com)", gotID, gotName)
	}
}

// 경로를 만들 수 없으면 조용히 일반 네트워크로 나가면 안 된다 — 사용자가 지정한 경로가 아니다.
func TestResolveTailnetDialSurfacesFailures(t *testing.T) {
	want := errors.New("tailnet support is not enabled")

	if _, err := ResolveTailnetDial(
		func(string, string) (DialFunc, error) { return nil, want },
		"net-a",
		"",
	); !errors.Is(err, want) {
		t.Errorf("ResolveTailnetDial() error = %v, want the resolver failure", err)
	}
}
