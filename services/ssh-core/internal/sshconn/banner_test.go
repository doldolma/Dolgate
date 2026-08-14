package sshconn

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/ssh"
)

func TestSanitizeBannerRemovesControlSequences(t *testing.T) {
	// 화면을 지우고 커서를 옮기는 CSI, 창 제목을 바꾸는 OSC, 앞줄을 덮어쓰는 \r 이 섞인 배너.
	raw := "\x1b[2J\x1b[H경고\r\n\x1b]0;제목\x07두 번째 줄\x00\n\n"

	got := sanitizeBanner(raw)
	const want = "경고\n두 번째 줄"
	if got != want {
		t.Fatalf("소독 결과가 다르다\n got: %q\nwant: %q", got, want)
	}
}

func TestTruncateBannerCapsLinesAndCollectorKeepsUrl(t *testing.T) {
	collector := &bannerCollector{}
	var builder strings.Builder
	for index := 0; index < maxBannerLines+5; index++ {
		fmt.Fprintf(&builder, "line %d\n", index)
	}
	// 눌러야 할 링크가 상한 **뒤쪽**에 있는 경우다. 잘려도 잃으면 안 된다.
	builder.WriteString("visit https://example.test/approve/abc\n")
	_ = collector.callback(builder.String())

	text := collector.Text()
	if lines := strings.Count(text, "\n") + 1; lines > maxBannerLines+1 {
		t.Fatalf("줄 상한을 넘겼다(%d줄):\n%s", lines, text)
	}
	if strings.Contains(text, "https://example.test") {
		t.Fatalf("링크가 상한 안에 들어왔다 — 이 테스트의 전제가 깨졌다:\n%s", text)
	}
	if got := collector.URL(); got != "https://example.test/approve/abc" {
		t.Fatalf("자르기 전 텍스트에서 링크를 찾지 못했다: %q", got)
	}
}

func TestTruncateBannerCapsBytesWithoutBreakingUTF8(t *testing.T) {
	// 줄 수는 하나뿐이지만 바이트 상한에 걸리는 배너. 한 글자가 3바이트라 상한이 문자 중간에 떨어진다.
	got := truncateBanner(strings.Repeat("가", maxBannerBytes))

	if len(got) > maxBannerBytes+len("\n…") {
		t.Fatalf("바이트 상한을 넘겼다: %d바이트", len(got))
	}
	if !utf8.ValidString(got) {
		t.Fatal("자르는 과정에서 UTF-8 이 깨졌다")
	}
}

// TestAnnotateHandshakeFailureIncludesLinkWithoutStall 은 정지가 아닌 실패에도 **링크가 있으면**
// 배너를 붙이는지 본다. 서버가 안내를 주고 인증을 거절하는 경우가 있어서다.
func TestAnnotateHandshakeFailureIncludesLinkWithoutStall(t *testing.T) {
	collector := &bannerCollector{}
	_ = collector.callback("승인이 필요합니다: https://example.test/a/1")

	got := annotateHandshakeFailure(
		errors.New("ssh: unable to authenticate"), collector, true).Error()

	if !strings.Contains(got, "https://example.test/a/1") {
		t.Fatalf("링크가 문구에 없다: %s", got)
	}
	// 정지가 아니므로 멈춘 단계를 말하면 안 된다 — 서버는 제때 답했다.
	if strings.Contains(got, "단계에서") {
		t.Fatalf("정지가 아닌데 단계를 말했다: %s", got)
	}
}

// TestDialClientReportsApprovalBannerWhenAuthStalls 는 실제로 겪은 상태를 재현한다.
//
// Tailscale SSH 의 `check` 모드는 승인 URL 을 **배너**(RFC 4252 §5.4)로 보내고, 사람이 브라우저에서
// 승인할 때까지 인증 응답을 보내지 않는다. x/crypto 는 BannerCallback 이 없으면 배너를 조용히
// 버리므로, 화면에는 이유 없이 멈춘 연결만 남았다. 이제는 그 URL 이 오류 문구에 실려야 한다.
func TestDialClientReportsApprovalBannerWhenAuthStalls(t *testing.T) {
	const approvalURL = "https://login.tailscale.com/a/le7a9c3c3519ae"
	const bannerText = "# Tailscale SSH requires an additional check.\n" +
		"# To authenticate, visit: " + approvalURL + "\n"

	// 승인을 기다리는 서버. 테스트가 끝날 때 풀어 준다 — sleep 으로 잡아 두면 테스트가 끝난 뒤에도
	// 고루틴이 남는다.
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })

	hostSigner, _ := generateTestKeyPair(t)
	serverConfig := &ssh.ServerConfig{
		NoClientAuth:   true,
		BannerCallback: func(ssh.ConnMetadata) string { return bannerText },
		NoClientAuthCallback: func(ssh.ConnMetadata) (*ssh.Permissions, error) {
			<-release
			return nil, fmt.Errorf("not approved")
		},
	}
	serverConfig.AddHostKey(hostSigner)
	host, port := startAuthTestServer(t, serverConfig)

	config := DefaultConfig
	config.HandshakeStallTimeout = 300 * time.Millisecond

	_, err := DialClient(context.Background(), Target{
		Host:                 host,
		Port:                 port,
		Username:             "ubuntu",
		AuthType:             "password",
		Password:             "pw",
		TrustedHostKeyBase64: base64.StdEncoding.EncodeToString(hostSigner.PublicKey().Marshal()),
	}, config, nil)
	if err == nil {
		t.Fatal("승인을 기다리는 서버에 연결이 성공했다고 보고했다")
	}

	message := err.Error()
	if !strings.Contains(message, approvalURL) {
		t.Fatalf("승인 URL 이 오류 문구에 없다: %s", message)
	}
	// 키 교환은 끝났고 인증에서 멈췄다는 것이 이 경우의 핵심 정보다.
	if !strings.Contains(message, "인증 단계") {
		t.Fatalf("멈춘 단계를 인증으로 말하지 않는다: %s", message)
	}
}

// startApprovalWaitingServer 는 배너를 보낸 뒤 approved 가 닫힐 때까지 인증에 답하지 않는 서버다.
// Tailscale SSH 의 `check` 모드가 하는 일과 같다.
func startApprovalWaitingServer(
	t *testing.T,
	bannerText string,
	approved <-chan struct{},
) (host string, port int, hostSigner ssh.Signer) {
	t.Helper()
	hostSigner, _ = generateTestKeyPair(t)
	serverConfig := &ssh.ServerConfig{
		NoClientAuth:   true,
		BannerCallback: func(ssh.ConnMetadata) string { return bannerText },
		NoClientAuthCallback: func(ssh.ConnMetadata) (*ssh.Permissions, error) {
			<-approved
			return nil, nil
		},
	}
	serverConfig.AddHostKey(hostSigner)
	host, port = startAuthTestServer(t, serverConfig)
	return host, port, hostSigner
}

// TestDialClientWaitsForApprovalWhenBannerIsShown 은 배너를 **화면에 보여줄 수 있을 때** 정지 감시가
// 사람을 기다려 주는지 본다. 이것이 되면 사용자는 승인 후 재시도할 필요가 없다.
func TestDialClientWaitsForApprovalWhenBannerIsShown(t *testing.T) {
	const bannerText = "# To authenticate, visit: https://login.tailscale.com/a/abc"

	approved := make(chan struct{})
	host, port, hostSigner := startApprovalWaitingServer(t, bannerText, approved)

	config := DefaultConfig
	config.HandshakeStallTimeout = 200 * time.Millisecond
	config.HandshakeApprovalTimeout = 5 * time.Second

	shown := make(chan string, 1)
	config.Banner = func(text string) {
		shown <- text
		// 사람이 브라우저로 가서 승인하고 돌아오는 시간. 정지 한도의 몇 배다.
		go func() {
			time.Sleep(3 * config.HandshakeStallTimeout)
			close(approved)
		}()
	}

	client, err := DialClient(context.Background(), Target{
		Host:                 host,
		Port:                 port,
		Username:             "ubuntu",
		AuthType:             "password",
		Password:             "pw",
		TrustedHostKeyBase64: base64.StdEncoding.EncodeToString(hostSigner.PublicKey().Marshal()),
	}, config, nil)
	if err != nil {
		t.Fatalf("승인을 기다리는 동안 정지로 오판했다: %v", err)
	}
	defer client.Close()

	select {
	case text := <-shown:
		if !strings.Contains(text, "https://login.tailscale.com/a/abc") {
			t.Fatalf("배너가 그대로 올라오지 않았다: %q", text)
		}
	default:
		t.Fatal("배너가 화면 쪽으로 올라오지 않았다")
	}
}

// TestDialClientDoesNotWaitWhenBannerCannotBeShown 은 보여줄 곳이 없을 때는 **평소 한도로 실패**하는지
// 본다. 보여줄 수 없는 안내를 몇 분씩 기다리는 것은 사용자에게는 그냥 멈춤이다 —
// SFTP·포트포워딩처럼 터미널이 없는 경로가 그렇고, 그쪽은 오류 문구로 배너를 받는다.
func TestDialClientDoesNotWaitWhenBannerCannotBeShown(t *testing.T) {
	const bannerText = "# To authenticate, visit: https://login.tailscale.com/a/abc"

	approved := make(chan struct{})
	t.Cleanup(func() { close(approved) })
	host, port, hostSigner := startApprovalWaitingServer(t, bannerText, approved)

	config := DefaultConfig
	config.HandshakeStallTimeout = 200 * time.Millisecond
	config.HandshakeApprovalTimeout = 30 * time.Second
	// Banner 를 주지 않는다 — 보여줄 곳이 없는 경로다.

	start := time.Now()
	_, err := DialClient(context.Background(), Target{
		Host:                 host,
		Port:                 port,
		Username:             "ubuntu",
		AuthType:             "password",
		Password:             "pw",
		TrustedHostKeyBase64: base64.StdEncoding.EncodeToString(hostSigner.PublicKey().Marshal()),
	}, config, nil)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("승인이 없었는데 연결이 성공했다고 보고했다")
	}
	if elapsed > 5*time.Second {
		t.Fatalf("보여줄 곳이 없는데도 승인 한도까지 기다렸다: %v", elapsed)
	}
	if !strings.Contains(err.Error(), "https://login.tailscale.com/a/abc") {
		t.Fatalf("배너가 오류 문구에 실리지 않았다: %s", err)
	}
}

// TestDialClientCancelDuringApprovalWait 는 승인을 기다리는 중에 취소가 **즉시** 듣는지 본다.
// ssh.NewClientConn 은 ctx 를 받지 않으므로 conn 을 닫아야 막힌 읽기가 풀린다. 이 배선이 없으면
// 사용자가 닫기를 눌러도 승인 한도까지 매달린다.
func TestDialClientCancelDuringApprovalWait(t *testing.T) {
	approved := make(chan struct{})
	t.Cleanup(func() { close(approved) })
	host, port, hostSigner := startApprovalWaitingServer(
		t, "# waiting for approval: https://example.test/a/1", approved)

	config := DefaultConfig
	config.HandshakeStallTimeout = 200 * time.Millisecond
	config.HandshakeApprovalTimeout = 30 * time.Second

	ctx, cancel := context.WithCancel(context.Background())
	config.Banner = func(string) {
		// 사용자가 안내를 보고 닫기를 누른 순간.
		go func() {
			time.Sleep(2 * config.HandshakeStallTimeout)
			cancel()
		}()
	}
	defer cancel()

	start := time.Now()
	_, err := DialClient(ctx, Target{
		Host:                 host,
		Port:                 port,
		Username:             "ubuntu",
		AuthType:             "password",
		Password:             "pw",
		TrustedHostKeyBase64: base64.StdEncoding.EncodeToString(hostSigner.PublicKey().Marshal()),
	}, config, nil)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("취소했는데 연결이 성공했다고 보고했다")
	}
	if elapsed > 5*time.Second {
		t.Fatalf("취소가 듣지 않아 승인 한도까지 기다렸다: %v", elapsed)
	}
}

// TestDialClientOmitsPlainBannerOnAuthFailure 는 흔한 경고문(MOTD)이 **엉뚱한 실패에 실리지 않는지**
// 본다. 거의 모든 회사 서버가 /etc/issue.net 을 보내므로, 비밀번호 하나 틀렸을 때 그 수십 줄이
// 함께 뜨면 진짜 원인이 묻힌다.
func TestDialClientOmitsPlainBannerOnAuthFailure(t *testing.T) {
	const motd = "AUTHORIZED USE ONLY\nAll activity is monitored."

	hostSigner, _ := generateTestKeyPair(t)
	serverConfig := &ssh.ServerConfig{
		BannerCallback: func(ssh.ConnMetadata) string { return motd },
		PasswordCallback: func(ssh.ConnMetadata, []byte) (*ssh.Permissions, error) {
			return nil, fmt.Errorf("bad password")
		},
	}
	serverConfig.AddHostKey(hostSigner)
	host, port := startAuthTestServer(t, serverConfig)

	_, err := DialClient(context.Background(), Target{
		Host:                 host,
		Port:                 port,
		Username:             "ubuntu",
		AuthType:             "password",
		Password:             "wrong",
		TrustedHostKeyBase64: base64.StdEncoding.EncodeToString(hostSigner.PublicKey().Marshal()),
	}, DefaultConfig, nil)
	if err == nil {
		t.Fatal("비밀번호가 틀렸는데 연결이 성공했다고 보고했다")
	}
	if strings.Contains(err.Error(), "AUTHORIZED USE ONLY") {
		t.Fatalf("평범한 경고문이 인증 실패 문구에 실렸다: %s", err)
	}
}

// TestDialClientNamesKexPhaseWhenServerNeverSpeaks 는 호스트 키를 받기도 전에 멈춘 경우를 인증
// 단계와 구분해 말하는지 본다. 이 둘은 볼 곳이 다르다 — 앞쪽은 경로·MTU·방화벽, 뒤쪽은 인증이다.
func TestDialClientNamesKexPhaseWhenServerNeverSpeaks(t *testing.T) {
	host, port := startSilentTestServer(t)
	hostSigner, _ := generateTestKeyPair(t)

	config := DefaultConfig
	config.HandshakeStallTimeout = 300 * time.Millisecond

	_, err := DialClient(context.Background(), Target{
		Host:                 host,
		Port:                 port,
		Username:             "ubuntu",
		AuthType:             "password",
		Password:             "pw",
		TrustedHostKeyBase64: base64.StdEncoding.EncodeToString(hostSigner.PublicKey().Marshal()),
	}, config, nil)
	if err == nil {
		t.Fatal("침묵하는 서버에 연결이 성공했다고 보고했다")
	}
	if !strings.Contains(err.Error(), "키 교환 단계") {
		t.Fatalf("멈춘 단계를 키 교환으로 말하지 않는다: %s", err)
	}
}
