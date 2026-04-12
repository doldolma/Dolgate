package serialsession

import (
	"bufio"
	"bytes"
	"fmt"
	"net"
	"sync"
	"time"

	"dolssh/services/ssh-core/internal/protocol"
)

const (
	telnetSE   = 240
	telnetSB   = 250
	telnetWILL = 251
	telnetWONT = 252
	telnetDO   = 253
	telnetDONT = 254
	telnetIAC  = 255

	telnetBinaryOption = 0
	comPortOption      = 44
)

const (
	rfc2217SetBaudRate = 1
	rfc2217SetDataSize = 2
	rfc2217SetParity   = 3
	rfc2217SetStopSize = 4
	rfc2217SetControl  = 5
)

const (
	rfc2217BreakOn  = 5
	rfc2217BreakOff = 6
	rfc2217DTROn    = 8
	rfc2217DTROff   = 9
	rfc2217RTSOn    = 11
	rfc2217RTSOff   = 12
)

type rfc2217Conn struct {
	conn   net.Conn
	reader *bufio.Reader
	write  sync.Mutex
}

func openRFC2217Transport(payload protocol.SerialConnectPayload) (sessionTransport, error) {
	address, err := validateRemoteAddress(payload, "rfc2217")
	if err != nil {
		return nil, err
	}

	conn, err := (&net.Dialer{Timeout: 5 * time.Second}).Dial("tcp", address)
	if err != nil {
		return nil, fmt.Errorf("RFC2217 negotiation failed: %w", err)
	}

	client := &rfc2217Conn{
		conn:   conn,
		reader: bufio.NewReader(conn),
	}

	if err := client.negotiate(payload); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("RFC2217 negotiation failed: %w", err)
	}

	return client, nil
}

func (c *rfc2217Conn) Read(buffer []byte) (int, error) {
	if len(buffer) == 0 {
		return 0, nil
	}

	written := 0
	for written < len(buffer) {
		value, err := c.reader.ReadByte()
		if err != nil {
			if ne, ok := err.(net.Error); ok && ne.Timeout() && written > 0 {
				return written, nil
			}
			return written, err
		}

		if value != telnetIAC {
			buffer[written] = value
			written++
			continue
		}

		dataValue, handled, err := c.readTelnetCommand()
		if err != nil {
			if ne, ok := err.(net.Error); ok && ne.Timeout() && written > 0 {
				return written, nil
			}
			return written, err
		}
		if handled {
			buffer[written] = dataValue
			written++
		}
	}

	return written, nil
}

func (c *rfc2217Conn) Write(data []byte) (int, error) {
	encoded := escapeTelnetPayload(data)

	c.write.Lock()
	defer c.write.Unlock()

	if err := writeAll(c.conn, encoded); err != nil {
		return 0, err
	}
	return len(data), nil
}

func (c *rfc2217Conn) Close() error {
	return c.conn.Close()
}

func (c *rfc2217Conn) Resize(cols, rows int) error {
	return nil
}

func (c *rfc2217Conn) SendBreak(duration time.Duration) error {
	if err := c.sendSubnegotiation(rfc2217SetControl, []byte{rfc2217BreakOn}); err != nil {
		return err
	}
	time.Sleep(duration)
	return c.sendSubnegotiation(rfc2217SetControl, []byte{rfc2217BreakOff})
}

func (c *rfc2217Conn) SetDTR(enabled bool) error {
	controlValue := byte(rfc2217DTROff)
	if enabled {
		controlValue = rfc2217DTROn
	}
	return c.sendSubnegotiation(rfc2217SetControl, []byte{controlValue})
}

func (c *rfc2217Conn) SetRTS(enabled bool) error {
	controlValue := byte(rfc2217RTSOff)
	if enabled {
		controlValue = rfc2217RTSOn
	}
	return c.sendSubnegotiation(rfc2217SetControl, []byte{controlValue})
}

func (c *rfc2217Conn) negotiate(payload protocol.SerialConnectPayload) error {
	if err := c.conn.SetDeadline(time.Now().Add(1500 * time.Millisecond)); err != nil {
		return err
	}
	defer func() {
		_ = c.conn.SetDeadline(time.Time{})
	}()

	if err := c.sendNegotiation(telnetWILL, comPortOption); err != nil {
		return err
	}
	if err := c.sendNegotiation(telnetDO, comPortOption); err != nil {
		return err
	}
	if err := c.sendNegotiation(telnetWILL, telnetBinaryOption); err != nil {
		return err
	}
	if err := c.sendNegotiation(telnetDO, telnetBinaryOption); err != nil {
		return err
	}

	clientCanSend := false
	serverCanSend := false

	for !(clientCanSend && serverCanSend) {
		value, err := c.reader.ReadByte()
		if err != nil {
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				break
			}
			return err
		}

		if value != telnetIAC {
			continue
		}

		command, err := c.reader.ReadByte()
		if err != nil {
			return err
		}

		if command == telnetIAC {
			continue
		}

		if command == telnetSB {
			if err := c.discardSubnegotiation(); err != nil {
				return err
			}
			continue
		}

		option, err := c.reader.ReadByte()
		if err != nil {
			return err
		}

		switch command {
		case telnetDO:
			if option == comPortOption {
				clientCanSend = true
				if err := c.sendNegotiation(telnetWILL, option); err != nil {
					return err
				}
				continue
			}
			if option == telnetBinaryOption {
				if err := c.sendNegotiation(telnetWILL, option); err != nil {
					return err
				}
				continue
			}
			if err := c.sendNegotiation(telnetWONT, option); err != nil {
				return err
			}
		case telnetWILL:
			if option == comPortOption {
				serverCanSend = true
				if err := c.sendNegotiation(telnetDO, option); err != nil {
					return err
				}
				continue
			}
			if option == telnetBinaryOption {
				if err := c.sendNegotiation(telnetDO, option); err != nil {
					return err
				}
				continue
			}
			if err := c.sendNegotiation(telnetDONT, option); err != nil {
				return err
			}
		case telnetWONT, telnetDONT:
			if option == comPortOption {
				return fmt.Errorf("remote server refused RFC2217 negotiation")
			}
		}
	}

	if !clientCanSend || !serverCanSend {
		return fmt.Errorf("remote server did not complete RFC2217 negotiation")
	}

	if err := c.configure(payload); err != nil {
		return err
	}
	return nil
}

func (c *rfc2217Conn) configure(payload protocol.SerialConnectPayload) error {
	var baudBytes [4]byte
	baudBytes[0] = byte(uint32(payload.BaudRate) >> 24)
	baudBytes[1] = byte(uint32(payload.BaudRate) >> 16)
	baudBytes[2] = byte(uint32(payload.BaudRate) >> 8)
	baudBytes[3] = byte(uint32(payload.BaudRate))

	commands := []struct {
		code  byte
		value []byte
	}{
		{code: rfc2217SetBaudRate, value: baudBytes[:]},
		{code: rfc2217SetDataSize, value: []byte{byte(payload.DataBits)}},
		{code: rfc2217SetParity, value: []byte{mapRFC2217Parity(payload.Parity)}},
		{code: rfc2217SetStopSize, value: []byte{mapRFC2217StopBits(payload.StopBits)}},
	}

	for _, command := range commands {
		if err := c.sendSubnegotiation(command.code, command.value); err != nil {
			return err
		}
	}

	for _, controlValue := range mapRFC2217FlowControl(payload.FlowControl) {
		if err := c.sendSubnegotiation(rfc2217SetControl, []byte{controlValue}); err != nil {
			return err
		}
	}

	return nil
}

func mapRFC2217Parity(value string) byte {
	switch value {
	case "odd":
		return 2
	case "even":
		return 3
	case "mark":
		return 4
	case "space":
		return 5
	default:
		return 1
	}
}

func mapRFC2217StopBits(value float64) byte {
	switch value {
	case 2:
		return 2
	case 1.5:
		return 3
	default:
		return 1
	}
}

func mapRFC2217FlowControl(value string) []byte {
	switch value {
	case "xon-xoff":
		return []byte{2, 15}
	case "rts-cts":
		return []byte{3, 16}
	case "dsr-dtr":
		return []byte{19, 18}
	default:
		return []byte{1, 14}
	}
}

func (c *rfc2217Conn) sendNegotiation(command, option byte) error {
	c.write.Lock()
	defer c.write.Unlock()
	return writeAll(c.conn, []byte{telnetIAC, command, option})
}

func (c *rfc2217Conn) sendSubnegotiation(command byte, value []byte) error {
	payload := make([]byte, 0, 4+len(value)*2+2)
	payload = append(payload, telnetIAC, telnetSB, comPortOption, command)
	payload = append(payload, escapeTelnetPayload(value)...)
	payload = append(payload, telnetIAC, telnetSE)

	c.write.Lock()
	defer c.write.Unlock()
	return writeAll(c.conn, payload)
}

func (c *rfc2217Conn) readTelnetCommand() (data byte, handled bool, err error) {
	command, err := c.reader.ReadByte()
	if err != nil {
		return 0, false, err
	}
	if command == telnetIAC {
		return telnetIAC, true, nil
	}
	if command == telnetSB {
		if err := c.discardSubnegotiation(); err != nil {
			return 0, false, err
		}
		return 0, false, nil
	}

	option, err := c.reader.ReadByte()
	if err != nil {
		return 0, false, err
	}

	switch command {
	case telnetDO:
		if option == comPortOption || option == telnetBinaryOption {
			return 0, false, c.sendNegotiation(telnetWILL, option)
		}
		return 0, false, c.sendNegotiation(telnetWONT, option)
	case telnetWILL:
		if option == comPortOption || option == telnetBinaryOption {
			return 0, false, c.sendNegotiation(telnetDO, option)
		}
		return 0, false, c.sendNegotiation(telnetDONT, option)
	case telnetDONT, telnetWONT:
		return 0, false, nil
	default:
		return 0, false, nil
	}
}

func (c *rfc2217Conn) discardSubnegotiation() error {
	for {
		value, err := c.reader.ReadByte()
		if err != nil {
			return err
		}
		if value != telnetIAC {
			continue
		}
		next, err := c.reader.ReadByte()
		if err != nil {
			return err
		}
		if next == telnetIAC {
			continue
		}
		if next == telnetSE {
			return nil
		}
	}
}

func escapeTelnetPayload(data []byte) []byte {
	if !bytes.Contains(data, []byte{telnetIAC}) {
		return append([]byte(nil), data...)
	}
	escaped := make([]byte, 0, len(data)+4)
	for _, value := range data {
		escaped = append(escaped, value)
		if value == telnetIAC {
			escaped = append(escaped, telnetIAC)
		}
	}
	return escaped
}
