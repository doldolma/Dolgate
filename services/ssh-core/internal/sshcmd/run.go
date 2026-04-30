package sshcmd

import (
	"bytes"
	"fmt"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

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

	var stdout bytes.Buffer
	var stderr bytes.Buffer
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
