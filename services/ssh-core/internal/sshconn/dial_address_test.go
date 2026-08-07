package sshconn

import (
	"net"
	"testing"
)

// IPv6 리터럴을 호스트로 넣으면 접속이 아예 안 됐다. 주소를 "%s:%d" 로 이어붙여
// "2001:db8::1:22" 를 만들었고 net.Dial 이 그것을 거부했다. 호스트 입력은 비어 있는지만
// 검사하므로 사용자가 IPv6 리터럴을 그대로 넣을 수 있다 — 즉 도달 가능한 경로였다.
func TestDialAddressBracketsIPv6Literals(t *testing.T) {
	cases := []struct {
		name string
		host string
		port int
		want string
	}{
		{name: "IPv6 리터럴은 대괄호로 감싼다", host: "2001:db8::1", port: 22, want: "[2001:db8::1]:22"},
		{name: "IPv6 루프백", host: "::1", port: 2222, want: "[::1]:2222"},
		{name: "IPv4 는 그대로", host: "192.168.0.10", port: 22, want: "192.168.0.10:22"},
		{name: "호스트명은 그대로", host: "nas.example.com", port: 2022, want: "nas.example.com:2022"},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := dialAddress(testCase.host, testCase.port)
			if got != testCase.want {
				t.Fatalf("dialAddress(%q, %d) = %q, want %q", testCase.host, testCase.port, got, testCase.want)
			}

			// 만든 주소가 실제로 다시 갈라지는지까지 본다 — 대괄호가 빠지면 여기서 걸린다.
			host, port, err := net.SplitHostPort(got)
			if err != nil {
				t.Fatalf("net.SplitHostPort(%q) 실패: %v", got, err)
			}
			if host != testCase.host {
				t.Fatalf("호스트가 왕복하지 않는다: %q → %q", testCase.host, host)
			}
			if port == "" {
				t.Fatalf("포트가 비었다: %q", got)
			}
		})
	}
}
