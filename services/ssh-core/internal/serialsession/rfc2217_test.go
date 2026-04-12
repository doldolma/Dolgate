package serialsession

import (
	"bufio"
	"bytes"
	"io"
	"net"
	"testing"
)

func TestRFC2217ConnSetDTRAndRTS(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()

	conn := &rfc2217Conn{
		conn:   client,
		reader: bufio.NewReader(client),
	}

	dtrResult := make(chan []byte, 1)
	go func() {
		dtrResult <- readExact(t, server, 7)
	}()
	if err := conn.SetDTR(true); err != nil {
		t.Fatalf("SetDTR returned error: %v", err)
	}
	if got := <-dtrResult; !bytes.Equal(got, []byte{telnetIAC, telnetSB, comPortOption, rfc2217SetControl, rfc2217DTROn, telnetIAC, telnetSE}) {
		t.Fatalf("unexpected DTR payload %#v", got)
	}

	rtsResult := make(chan []byte, 1)
	go func() {
		rtsResult <- readExact(t, server, 7)
	}()
	if err := conn.SetRTS(false); err != nil {
		t.Fatalf("SetRTS returned error: %v", err)
	}
	if got := <-rtsResult; !bytes.Equal(got, []byte{telnetIAC, telnetSB, comPortOption, rfc2217SetControl, rfc2217RTSOff, telnetIAC, telnetSE}) {
		t.Fatalf("unexpected RTS payload %#v", got)
	}
}

func TestRFC2217ConnSendBreak(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()

	conn := &rfc2217Conn{
		conn:   client,
		reader: bufio.NewReader(client),
	}

	result := make(chan []byte, 1)
	go func() {
		result <- readExact(t, server, 14)
	}()
	if err := conn.SendBreak(0); err != nil {
		t.Fatalf("SendBreak returned error: %v", err)
	}

	expected := []byte{
		telnetIAC, telnetSB, comPortOption, rfc2217SetControl, rfc2217BreakOn, telnetIAC, telnetSE,
		telnetIAC, telnetSB, comPortOption, rfc2217SetControl, rfc2217BreakOff, telnetIAC, telnetSE,
	}
	if got := <-result; !bytes.Equal(got, expected) {
		t.Fatalf("unexpected break payload %#v", got)
	}
}

func readExact(t *testing.T, reader io.Reader, length int) []byte {
	t.Helper()
	buffer := make([]byte, length)
	if _, err := io.ReadFull(reader, buffer); err != nil {
		t.Fatalf("ReadFull returned error: %v", err)
	}
	return buffer
}
