package sshcmd

import (
	"bytes"
	"fmt"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

// syncBuffer 는 쓰는 쪽과 읽는 쪽이 다른 고루틴일 때 쓰는 버퍼다.
//
// Bytes 는 **복사본**을 돌려준다. 내부 슬라이스를 그대로 넘기면 호출자가 읽는 동안 복사 고루틴이
// 같은 배열에 이어 써서, 잠금을 둔 의미가 없어진다.
type syncBuffer struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (b *syncBuffer) Write(data []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.Write(data)
}

func (b *syncBuffer) Bytes() []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]byte(nil), b.buffer.Bytes()...)
}

func QuotePosix(value string) string {
	if value == "" {
		return "''"
	}
	return "'" + strings.ReplaceAll(value, "'", `'"'"'`) + "'"
}

func Run(client *ssh.Client, command string) ([]byte, []byte, error) {
	return RunWithTimeout(client, command, 0)
}

func RunWithTimeout(
	client *ssh.Client,
	command string,
	timeout time.Duration,
) ([]byte, []byte, error) {
	return RunWithInputWithTimeout(client, command, nil, timeout)
}

func RunWithInputWithTimeout(
	client *ssh.Client,
	command string,
	stdin []byte,
	timeout time.Duration,
) ([]byte, []byte, error) {
	session, err := client.NewSession()
	if err != nil {
		return nil, nil, err
	}
	defer session.Close()

	// 잠금이 있는 버퍼를 쓴다.
	//
	// 시간이 초과되면 아래에서 세션을 닫고 **곧바로** 지금까지의 출력을 돌려주는데, 그 시점에도
	// x/crypto 의 복사 고루틴은 아직 이 버퍼에 쓰고 있다. 평범한 bytes.Buffer 로 읽으면 그것이
	// 데이터 경쟁이다(-race 가 실제로 잡는다) — 잘린 출력이나 패닉으로 이어질 수 있다.
	//
	// 출력을 포기하지 않는 이유: 시간 초과의 원인이 대개 그 부분 출력에 적혀 있다(mosh 부트스트랩이
	// stderr 를 그대로 사용자에게 보여 준다).
	var stdout syncBuffer
	var stderr syncBuffer
	session.Stdout = &stdout
	session.Stderr = &stderr
	if stdin != nil {
		session.Stdin = bytes.NewReader(stdin)
	}

	if timeout <= 0 {
		err = session.Run(command)
		return stdout.Bytes(), stderr.Bytes(), err
	}

	done := make(chan error, 1)
	go func() {
		done <- session.Run(command)
	}()

	select {
	case err = <-done:
		return stdout.Bytes(), stderr.Bytes(), err
	case <-time.After(timeout):
		_ = session.Close()
		err = fmt.Errorf("command timed out after %s", timeout)
		return stdout.Bytes(), stderr.Bytes(), err
	}
}
