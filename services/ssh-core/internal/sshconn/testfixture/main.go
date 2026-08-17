// fake-sshd 는 e2e 가 붙는 가짜 SSH 서버다.
//
// **왜 필요한가:** 연결 화면(호스트 키 신뢰 카드, OTP 입력창, 홉 진행)은 실제로 붙어 봐야 검증할
// 수 있는데, 그 조건을 진짜 서버로 만들려면 OTP 를 쓰는 베스천과 처음 보는 호스트가 필요하다.
// 여기서는 그것을 플래그로 만든다 — 사람 손도, 네트워크도 필요 없다.
//
// 앱이 붙을 수 있게 최소한만 한다: 호스트 키 하나, 인증 한 종류, 그리고 pty+shell. 점프로 쓸
// 때는 direct-tcpip 를 중계한다.
//
// 기동하면 stdout 에 두 줄을 쓴다. e2e 가 이것을 읽어 호스트를 시드한다.
//
//	LISTENING 127.0.0.1:54321
//	HOSTKEY <base64>
package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"

	"golang.org/x/crypto/ssh"
)

func main() {
	username := flag.String("user", "ubuntu", "받아 줄 사용자")
	password := flag.String("password", "pw", "비밀번호(비면 password 방식을 제시하지 않는다)")
	otpCode := flag.String("otp", "", "설정하면 keyboard-interactive 로 비밀번호+코드를 묻는다")
	banner := flag.String("banner", "", "설정하면 인증 단계에 이 배너를 보낸다")
	relay := flag.Bool("relay", false, "direct-tcpip 를 중계한다(점프 호스트로 쓸 때)")
	flag.Parse()

	signer, err := generateHostKey()
	if err != nil {
		fmt.Fprintf(os.Stderr, "host key: %v\n", err)
		os.Exit(1)
	}

	config := &ssh.ServerConfig{}
	config.AddHostKey(signer)
	if *banner != "" {
		config.BannerCallback = func(ssh.ConnMetadata) string { return *banner }
	}
	if *otpCode != "" {
		// OTP 서버는 비밀번호와 코드를 **다른 라운드**로 묻는다. 한 라운드로 묶으면 "저장된
		// 비밀번호는 자동으로 답하고 코드만 사람에게 묻는다" 를 확인할 수 없다.
		config.KeyboardInteractiveCallback = func(
			_ ssh.ConnMetadata,
			ask ssh.KeyboardInteractiveChallenge,
		) (*ssh.Permissions, error) {
			given, askErr := ask("", "", []string{"Password:"}, []bool{false})
			if askErr != nil {
				return nil, askErr
			}
			if len(given) != 1 || given[0] != *password {
				return nil, fmt.Errorf("password rejected")
			}
			given, askErr = ask("", "", []string{"Verification code:"}, []bool{false})
			if askErr != nil {
				return nil, askErr
			}
			if len(given) != 1 || given[0] != *otpCode {
				return nil, fmt.Errorf("code rejected")
			}
			return nil, nil
		}
	} else if *password != "" {
		config.PasswordCallback = func(conn ssh.ConnMetadata, given []byte) (*ssh.Permissions, error) {
			if conn.User() == *username && string(given) == *password {
				return nil, nil
			}
			return nil, fmt.Errorf("password rejected")
		}
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fmt.Fprintf(os.Stderr, "listen: %v\n", err)
		os.Exit(1)
	}

	// 이 두 줄이 e2e 와의 약속이다. 주소는 호스트 시드에, 호스트 키는 "이미 신뢰함" 을 만들 때
	// known_hosts 시드에 쓴다(신뢰 카드를 보려는 시나리오는 그것을 심지 않는다).
	fmt.Printf("LISTENING %s\n", listener.Addr().String())
	fmt.Printf("HOSTKEY %s\n", base64.StdEncoding.EncodeToString(signer.PublicKey().Marshal()))
	os.Stdout.Sync()

	for {
		raw, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		go serve(raw, config, *relay)
	}
}

func generateHostKey() (ssh.Signer, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	return ssh.NewSignerFromKey(key)
}

func serve(raw net.Conn, config *ssh.ServerConfig, relay bool) {
	conn, chans, reqs, err := ssh.NewServerConn(raw, config)
	if err != nil {
		_ = raw.Close()
		return
	}
	defer conn.Close()
	go ssh.DiscardRequests(reqs)

	for newChannel := range chans {
		switch {
		case newChannel.ChannelType() == "direct-tcpip" && relay:
			go relayDirectTCPIP(newChannel)
		case newChannel.ChannelType() == "session":
			go serveSession(newChannel)
		default:
			_ = newChannel.Reject(ssh.UnknownChannelType, "unsupported")
		}
	}
}

func relayDirectTCPIP(newChannel ssh.NewChannel) {
	var extra struct {
		DestAddr   string
		DestPort   uint32
		OriginAddr string
		OriginPort uint32
	}
	if err := ssh.Unmarshal(newChannel.ExtraData(), &extra); err != nil {
		_ = newChannel.Reject(ssh.ConnectionFailed, "bad payload")
		return
	}
	upstream, err := net.Dial("tcp", net.JoinHostPort(extra.DestAddr, strconv.Itoa(int(extra.DestPort))))
	if err != nil {
		_ = newChannel.Reject(ssh.ConnectionFailed, err.Error())
		return
	}
	channel, requests, err := newChannel.Accept()
	if err != nil {
		_ = upstream.Close()
		return
	}
	go ssh.DiscardRequests(requests)
	go func() {
		_, _ = io.Copy(channel, upstream)
		_ = channel.Close()
	}()
	go func() {
		_, _ = io.Copy(upstream, channel)
		_ = upstream.Close()
	}()
}

// serveSession 은 셸 흉내를 낸다.
//
// 붙은 것을 화면이 알아볼 수 있어야 하므로 표식을 하나 찍는다 — e2e 는 터미널 출력에서 이것을
// 찾아 "정말 붙었다" 를 판정한다. 입력은 그대로 되돌려 준다(에코).
func serveSession(newChannel ssh.NewChannel) {
	channel, requests, err := newChannel.Accept()
	if err != nil {
		return
	}
	defer channel.Close()

	go func() {
		for request := range requests {
			switch request.Type {
			case "pty-req", "env", "window-change":
				if request.WantReply {
					_ = request.Reply(true, nil)
				}
			case "shell", "exec":
				if request.WantReply {
					_ = request.Reply(true, nil)
				}
				_, _ = io.WriteString(channel, "READY:FAKE_SSHD\r\n")
			default:
				if request.WantReply {
					_ = request.Reply(false, nil)
				}
			}
		}
	}()

	// 입력을 되돌려 준다. 셸이 살아 있다는 것을 화면에서 확인할 수 있게 한다.
	_, _ = io.Copy(channel, channel)
}
