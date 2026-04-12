package serialsession

import (
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"time"

	"dolssh/services/ssh-core/internal/protocol"
	"go.bug.st/serial"
)

type EventEmitter func(protocol.Event)
type StreamEmitter func(protocol.StreamFrame, []byte)

type sessionTransport interface {
	io.ReadWriteCloser
	Resize(cols, rows int) error
}

type serialControlTransport interface {
	SendBreak(duration time.Duration) error
	SetDTR(enabled bool) error
	SetRTS(enabled bool) error
}

type transportFactory func(protocol.SerialConnectPayload) (sessionTransport, error)
type portLister func(includeBusy bool) ([]protocol.SerialPortSummary, error)

type sessionHandle struct {
	transport           sessionTransport
	payload             protocol.SerialConnectPayload
	writeMu             sync.Mutex
	lineBuffer          []byte
	disconnectRequested bool
	errorNotified       bool
	closeOnce           sync.Once
}

type Manager struct {
	mu            sync.RWMutex
	sessions      map[string]*sessionHandle
	emit          EventEmitter
	emitStream    StreamEmitter
	openTransport transportFactory
	listPorts     portLister
}

func NewManager(emit EventEmitter, stream StreamEmitter) *Manager {
	return NewManagerWithDeps(emit, stream, defaultTransportFactory, defaultPortLister)
}

func NewManagerWithDeps(
	emit EventEmitter,
	stream StreamEmitter,
	openTransport transportFactory,
	listPorts portLister,
) *Manager {
	if openTransport == nil {
		openTransport = defaultTransportFactory
	}
	if listPorts == nil {
		listPorts = defaultPortLister
	}

	return &Manager{
		sessions:      make(map[string]*sessionHandle),
		emit:          emit,
		emitStream:    stream,
		openTransport: openTransport,
		listPorts:     listPorts,
	}
}

func (m *Manager) Connect(sessionID, requestID string, payload protocol.SerialConnectPayload) error {
	transport, err := m.openTransport(payload)
	if err != nil {
		return err
	}

	handle := &sessionHandle{
		transport: transport,
		payload:   payload,
	}

	m.mu.Lock()
	m.sessions[sessionID] = handle
	m.mu.Unlock()

	m.emit(protocol.Event{
		Type:      protocol.EventConnected,
		RequestID: requestID,
		SessionID: sessionID,
		Payload: protocol.StatusPayload{
			Status:    "connected",
			ShellKind: "serial",
		},
	})

	go m.stream(sessionID, handle)
	return nil
}

func (m *Manager) ListPorts(requestID string, payload protocol.SerialListPortsPayload) error {
	ports, err := m.listPorts(payload.IncludeBusy)
	if err != nil {
		return err
	}

	m.emit(protocol.Event{
		Type:      protocol.EventSerialPortsListed,
		RequestID: requestID,
		Payload: protocol.SerialPortsListedPayload{
			Ports: ports,
		},
	})
	return nil
}

func (m *Manager) HasSession(sessionID string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	_, ok := m.sessions[sessionID]
	return ok
}

func (m *Manager) WriteBytes(sessionID string, data []byte) error {
	session, err := m.getSession(sessionID)
	if err != nil {
		return err
	}

	session.writeMu.Lock()
	defer session.writeMu.Unlock()

	if session.payload.LocalLineEditing {
		return m.writeWithLocalLineEditing(sessionID, session, data)
	}

	if session.payload.LocalEcho {
		m.emitData(sessionID, data)
	}

	return writeAll(
		session.transport,
		applyTransmitLineEnding(data, session.payload.TransmitLineEnding),
	)
}

func (m *Manager) Control(sessionID, action string, enabled *bool) error {
	session, err := m.getSession(sessionID)
	if err != nil {
		return err
	}

	controlTransport, ok := session.transport.(serialControlTransport)
	if !ok {
		return fmt.Errorf(
			"serial control action not supported for transport: %s",
			session.payload.Transport,
		)
	}

	session.writeMu.Lock()
	defer session.writeMu.Unlock()

	switch action {
	case "break":
		return controlTransport.SendBreak(250 * time.Millisecond)
	case "set-dtr":
		if enabled == nil {
			return errors.New("enabled is required for set-dtr")
		}
		return controlTransport.SetDTR(*enabled)
	case "set-rts":
		if enabled == nil {
			return errors.New("enabled is required for set-rts")
		}
		return controlTransport.SetRTS(*enabled)
	default:
		return fmt.Errorf("unsupported serial control action: %s", action)
	}
}

func (m *Manager) Resize(sessionID string, cols, rows int) error {
	session, err := m.getSession(sessionID)
	if err != nil {
		return err
	}
	return session.transport.Resize(cols, rows)
}

func (m *Manager) Disconnect(sessionID string) error {
	m.mu.Lock()
	session, ok := m.sessions[sessionID]
	if !ok {
		m.mu.Unlock()
		return nil
	}
	session.disconnectRequested = true
	m.mu.Unlock()

	return session.transport.Close()
}

func (m *Manager) stream(sessionID string, handle *sessionHandle) {
	buffer := make([]byte, 4096)
	for {
		n, err := handle.transport.Read(buffer)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buffer[:n])
			m.emitData(sessionID, chunk)
		}

		if err != nil {
			if err != io.EOF && m.HasSession(sessionID) {
				m.emitSessionError(sessionID, err.Error())
			}
			disconnectRequested, _ := m.sessionFlags(sessionID)
			message := ""
			if disconnectRequested {
				message = "client requested disconnect"
			} else if err != nil && !errors.Is(err, io.EOF) {
				message = err.Error()
			}
			m.closeSession(sessionID, message)
			return
		}
	}
}

func (m *Manager) emitData(sessionID string, data []byte) {
	if len(data) == 0 {
		return
	}
	chunk := make([]byte, len(data))
	copy(chunk, data)
	m.emitStream(protocol.StreamFrame{
		Type:      protocol.StreamTypeData,
		SessionID: sessionID,
	}, chunk)
}

func (m *Manager) writeWithLocalLineEditing(
	sessionID string,
	session *sessionHandle,
	data []byte,
) error {
	for index := 0; index < len(data); index++ {
		value := data[index]
		switch value {
		case '\b', 0x7f:
			if len(session.lineBuffer) > 0 {
				session.lineBuffer = session.lineBuffer[:len(session.lineBuffer)-1]
				m.emitData(sessionID, []byte("\b \b"))
				continue
			}
			if err := writeAll(session.transport, []byte{value}); err != nil {
				return err
			}
		case '\r', '\n':
			if len(session.lineBuffer) > 0 {
				if err := writeAll(session.transport, session.lineBuffer); err != nil {
					return err
				}
				session.lineBuffer = session.lineBuffer[:0]
			}
			if err := writeAll(
				session.transport,
				resolveTransmitLineEndingBytes(value, session.payload.TransmitLineEnding),
			); err != nil {
				return err
			}
			if value == '\r' && index+1 < len(data) && data[index+1] == '\n' {
				index++
			}
			m.emitData(sessionID, []byte{value})
		default:
			if value < 0x20 {
				if err := writeAll(session.transport, []byte{value}); err != nil {
					return err
				}
				continue
			}
			session.lineBuffer = append(session.lineBuffer, value)
			m.emitData(sessionID, []byte{value})
		}
	}
	return nil
}

func (m *Manager) emitSessionError(sessionID, message string) {
	m.mu.Lock()
	session, ok := m.sessions[sessionID]
	if !ok || session.errorNotified {
		m.mu.Unlock()
		return
	}
	session.errorNotified = true
	m.mu.Unlock()

	m.emit(protocol.Event{
		Type:      protocol.EventError,
		SessionID: sessionID,
		Payload: protocol.ErrorPayload{
			Message: message,
		},
	})
}

func (m *Manager) closeSession(sessionID, message string) {
	m.mu.Lock()
	session, ok := m.sessions[sessionID]
	if ok {
		delete(m.sessions, sessionID)
	}
	m.mu.Unlock()
	if !ok {
		return
	}

	session.closeOnce.Do(func() {
		_ = session.transport.Close()
		m.emit(protocol.Event{
			Type:      protocol.EventClosed,
			SessionID: sessionID,
			Payload: protocol.ClosedPayload{
				Message: message,
			},
		})
	})
}

func (m *Manager) sessionFlags(sessionID string) (disconnectRequested bool, errorNotified bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	session, ok := m.sessions[sessionID]
	if !ok {
		return false, false
	}
	return session.disconnectRequested, session.errorNotified
}

func (m *Manager) getSession(sessionID string) (*sessionHandle, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	session, ok := m.sessions[sessionID]
	if !ok {
		return nil, fmt.Errorf("serial session not found: %s", sessionID)
	}
	return session, nil
}

func writeAll(writer io.Writer, data []byte) error {
	for len(data) > 0 {
		written, err := writer.Write(data)
		if err != nil {
			return err
		}
		data = data[written:]
	}
	return nil
}

func applyTransmitLineEnding(data []byte, lineEnding string) []byte {
	normalized := normalizeTransmitLineEnding(lineEnding)
	if normalized == "none" || len(data) == 0 {
		return append([]byte(nil), data...)
	}

	lineEndingBytes := lineEndingBytesFor(normalized)
	result := make([]byte, 0, len(data)+len(lineEndingBytes))
	for index := 0; index < len(data); index++ {
		switch data[index] {
		case '\r':
			if index+1 < len(data) && data[index+1] == '\n' {
				index++
			}
			result = append(result, lineEndingBytes...)
		case '\n':
			result = append(result, lineEndingBytes...)
		default:
			result = append(result, data[index])
		}
	}
	return result
}

func resolveTransmitLineEndingBytes(value byte, lineEnding string) []byte {
	normalized := normalizeTransmitLineEnding(lineEnding)
	if normalized == "none" {
		return []byte{value}
	}
	return lineEndingBytesFor(normalized)
}

func normalizeTransmitLineEnding(value string) string {
	switch value {
	case "cr", "lf", "crlf":
		return value
	default:
		return "none"
	}
}

func lineEndingBytesFor(value string) []byte {
	switch value {
	case "cr":
		return []byte{'\r'}
	case "lf":
		return []byte{'\n'}
	case "crlf":
		return []byte{'\r', '\n'}
	default:
		return []byte{'\r'}
	}
}

func defaultTransportFactory(payload protocol.SerialConnectPayload) (sessionTransport, error) {
	switch payload.Transport {
	case "local":
		return openLocalTransport(payload)
	case "raw-tcp":
		return openRawTCPTransport(payload)
	case "rfc2217":
		return openRFC2217Transport(payload)
	default:
		return nil, fmt.Errorf("unsupported serial transport: %s", payload.Transport)
	}
}

func defaultPortLister(_ bool) ([]protocol.SerialPortSummary, error) {
	ports, err := serial.GetPortsList()
	if err != nil {
		return nil, err
	}

	result := make([]protocol.SerialPortSummary, 0, len(ports))
	for _, port := range ports {
		if port == "" {
			continue
		}
		result = append(result, protocol.SerialPortSummary{
			Path:        port,
			DisplayName: port,
		})
	}
	return result, nil
}

type localSerialTransport struct {
	port serial.Port
}

func (t *localSerialTransport) Read(buffer []byte) (int, error) {
	return t.port.Read(buffer)
}

func (t *localSerialTransport) Write(data []byte) (int, error) {
	return t.port.Write(data)
}

func (t *localSerialTransport) Resize(cols, rows int) error {
	return nil
}

func (t *localSerialTransport) Close() error {
	return t.port.Close()
}

func (t *localSerialTransport) SendBreak(duration time.Duration) error {
	return t.port.Break(duration)
}

func (t *localSerialTransport) SetDTR(enabled bool) error {
	return t.port.SetDTR(enabled)
}

func (t *localSerialTransport) SetRTS(enabled bool) error {
	return t.port.SetRTS(enabled)
}

type streamTransport struct {
	reader io.Reader
	writer io.Writer
	closer io.Closer
}

func (t *streamTransport) Read(buffer []byte) (int, error) {
	return t.reader.Read(buffer)
}

func (t *streamTransport) Write(data []byte) (int, error) {
	return t.writer.Write(data)
}

func (t *streamTransport) Resize(cols, rows int) error {
	return nil
}

func (t *streamTransport) Close() error {
	return t.closer.Close()
}

func openLocalTransport(payload protocol.SerialConnectPayload) (sessionTransport, error) {
	devicePath := payload.DevicePath
	if devicePath == "" {
		return nil, errors.New("serial device path is required")
	}

	mode, err := buildLocalSerialMode(payload)
	if err != nil {
		return nil, err
	}

	port, err := serial.Open(devicePath, mode)
	if err != nil {
		return nil, mapLocalSerialOpenError(devicePath, err)
	}
	if err := port.SetReadTimeout(serial.NoTimeout); err != nil {
		_ = port.Close()
		return nil, err
	}
	return &localSerialTransport{port: port}, nil
}

func buildLocalSerialMode(payload protocol.SerialConnectPayload) (*serial.Mode, error) {
	parity, err := mapLocalSerialParity(payload.Parity)
	if err != nil {
		return nil, err
	}
	stopBits, err := mapLocalSerialStopBits(payload.StopBits)
	if err != nil {
		return nil, err
	}

	return &serial.Mode{
		BaudRate: payload.BaudRate,
		DataBits: payload.DataBits,
		Parity:   parity,
		StopBits: stopBits,
	}, nil
}

func mapLocalSerialParity(value string) (serial.Parity, error) {
	switch value {
	case "none":
		return serial.NoParity, nil
	case "odd":
		return serial.OddParity, nil
	case "even":
		return serial.EvenParity, nil
	case "mark":
		return serial.MarkParity, nil
	case "space":
		return serial.SpaceParity, nil
	default:
		return serial.NoParity, fmt.Errorf("unsupported serial parity: %s", value)
	}
}

func mapLocalSerialStopBits(value float64) (serial.StopBits, error) {
	switch value {
	case 1:
		return serial.OneStopBit, nil
	case 1.5:
		return serial.OnePointFiveStopBits, nil
	case 2:
		return serial.TwoStopBits, nil
	default:
		return serial.OneStopBit, fmt.Errorf("unsupported serial stop bits: %g", value)
	}
}

func mapLocalSerialOpenError(devicePath string, err error) error {
	var portErr serial.PortError
	if errors.As(err, &portErr) {
		switch portErr.Code() {
		case serial.PortNotFound:
			return fmt.Errorf("local serial device not found: %s", devicePath)
		case serial.PermissionDenied:
			return fmt.Errorf("permission denied opening serial device: %s", devicePath)
		default:
			return fmt.Errorf("serial device open failed: %w", err)
		}
	}
	return fmt.Errorf("serial device open failed: %w", err)
}

func openRawTCPTransport(payload protocol.SerialConnectPayload) (sessionTransport, error) {
	address, err := validateRemoteAddress(payload, "raw-tcp")
	if err != nil {
		return nil, err
	}

	conn, err := (&net.Dialer{Timeout: 5 * time.Second}).Dial("tcp", address)
	if err != nil {
		return nil, fmt.Errorf("raw TCP connect failed: %w", err)
	}
	return &streamTransport{
		reader: conn,
		writer: conn,
		closer: conn,
	}, nil
}

func validateRemoteAddress(payload protocol.SerialConnectPayload, transport string) (string, error) {
	if payload.Host == "" {
		return "", fmt.Errorf("%s host is required", transport)
	}
	if payload.Port <= 0 {
		return "", fmt.Errorf("%s port is required", transport)
	}
	return net.JoinHostPort(payload.Host, fmt.Sprintf("%d", payload.Port)), nil
}
