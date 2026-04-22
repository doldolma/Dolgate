package http

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type awsSessionStartRequest struct {
	HostID      string            `json:"hostId"`
	Label       string            `json:"label"`
	ProfileName string            `json:"profileName"`
	Region      string            `json:"region"`
	InstanceID  string            `json:"instanceId"`
	Cols        int               `json:"cols"`
	Rows        int               `json:"rows"`
	Env         map[string]string `json:"env,omitempty"`
	UnsetEnv    []string          `json:"unsetEnv,omitempty"`
}

type awsSessionClientMessage struct {
	Type       string                  `json:"type"`
	Payload    *awsSessionStartRequest `json:"payload,omitempty"`
	DataBase64 string                  `json:"dataBase64,omitempty"`
	Cols       int                     `json:"cols,omitempty"`
	Rows       int                     `json:"rows,omitempty"`
}

type awsSessionServerMessage struct {
	Type       string `json:"type"`
	DataBase64 string `json:"dataBase64,omitempty"`
	Message    string `json:"message,omitempty"`
}

type awsSessionRuntimeEvent struct {
	Type    string
	Message string
	Data    []byte
}

type awsSessionRunner interface {
	Events() <-chan awsSessionRuntimeEvent
	Write([]byte) error
	Resize(cols, rows int) error
	Close() error
}

type awsSessionReasonCloser interface {
	CloseWithReason(reason string) error
}

type awsSessionRunnerFactory func(AwsSsmRuntime, awsSessionStartRequest) (awsSessionRunner, error)

type awsSessionOutboundMessage struct {
	message         awsSessionServerMessage
	closeAfterWrite bool
}

const (
	awsSessionPingInterval  = 15 * time.Second
	awsSessionReadTimeout   = 45 * time.Second
	awsSessionWriteTimeout  = 10 * time.Second
	awsSessionOutboundQueue = 64
)

type AwsSessionHub struct {
	runtime        AwsSsmRuntime
	upgrader       websocket.Upgrader
	factory        awsSessionRunnerFactory
	pingInterval   time.Duration
	pongWait       time.Duration
	writeWait      time.Duration
	outboundBuffer int
}

func NewAwsSessionHub(runtime AwsSsmRuntime, factory awsSessionRunnerFactory) *AwsSessionHub {
	if factory == nil {
		factory = func(AwsSsmRuntime, awsSessionStartRequest) (awsSessionRunner, error) {
			return nil, errors.New("AWS session runtime bridge is not configured")
		}
	}

	return &AwsSessionHub{
		runtime: runtime,
		upgrader: websocket.Upgrader{
			CheckOrigin: func(_ *http.Request) bool {
				return true
			},
		},
		factory:        factory,
		pingInterval:   awsSessionPingInterval,
		pongWait:       awsSessionReadTimeout,
		writeWait:      awsSessionWriteTimeout,
		outboundBuffer: awsSessionOutboundQueue,
	}
}

func (hub *AwsSessionHub) HandleWebSocket(writer http.ResponseWriter, request *http.Request) error {
	if !hub.runtime.Enabled {
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusServiceUnavailable)
		return json.NewEncoder(writer).Encode(map[string]string{
			"error": "AWS SSM runtime is unavailable on this server.",
		})
	}

	conn, err := hub.upgrader.Upgrade(writer, request, nil)
	if err != nil {
		return err
	}

	socket := &lockedWebSocket{conn: conn}
	defer socket.Close()

	ctx, cancel := context.WithCancel(request.Context())
	defer cancel()

	if err := conn.SetReadDeadline(time.Now().Add(hub.pongWait)); err != nil {
		return err
	}
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(hub.pongWait))
	})

	outgoing := make(chan awsSessionOutboundMessage, hub.outboundBuffer)
	var (
		runnerMu     sync.RWMutex
		runner       awsSessionRunner
		teardownOnce sync.Once
	)

	requestTeardown := func(reason string) {
		teardownOnce.Do(func() {
			runnerMu.RLock()
			activeRunner := runner
			runnerMu.RUnlock()
			closeAwsSessionRunner(activeRunner, reason)
			cancel()
			_ = socket.Close()
		})
	}

	enqueue := func(message awsSessionServerMessage, closeAfterWrite bool) bool {
		select {
		case outgoing <- awsSessionOutboundMessage{message: message, closeAfterWrite: closeAfterWrite}:
			return true
		case <-ctx.Done():
			return false
		default:
			requestTeardown("backpressure")
			return false
		}
	}

	go func() {
		ticker := time.NewTicker(hub.pingInterval)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case message := <-outgoing:
				if err := socket.WriteJSON(message.message, hub.writeWait); err != nil {
					requestTeardown(awsSessionTransportReason(err))
					return
				}
				if message.closeAfterWrite {
					requestTeardown("client_close")
					return
				}
			case <-ticker.C:
				if err := socket.WriteControl(websocket.PingMessage, nil, hub.writeWait); err != nil {
					requestTeardown(awsSessionTransportReason(err))
					return
				}
			}
		}
	}()

	for {
		_, payload, err := conn.ReadMessage()
		if err != nil {
			requestTeardown(awsSessionTransportReason(err))
			return nil
		}

		var message awsSessionClientMessage
		if err := json.Unmarshal(payload, &message); err != nil {
			if !enqueue(awsSessionServerMessage{
				Type:    "error",
				Message: "invalid AWS session websocket payload",
			}, false) {
				return nil
			}
			continue
		}

		runnerMu.RLock()
		activeRunner := runner
		runnerMu.RUnlock()

		switch message.Type {
		case "start":
			if activeRunner != nil {
				if !enqueue(awsSessionServerMessage{
					Type:    "error",
					Message: "AWS session already started",
				}, false) {
					return nil
				}
				continue
			}
			if message.Payload == nil {
				if !enqueue(awsSessionServerMessage{
					Type:    "error",
					Message: "missing start payload",
				}, false) {
					return nil
				}
				continue
			}
			if validationError := validateAwsSessionStartRequest(*message.Payload); validationError != nil {
				if !enqueue(awsSessionServerMessage{
					Type:    "error",
					Message: validationError.Error(),
				}, false) {
					return nil
				}
				continue
			}

			nextRunner, err := hub.factory(hub.runtime, *message.Payload)
			if err != nil {
				if !enqueue(awsSessionServerMessage{
					Type:    "error",
					Message: err.Error(),
				}, false) {
					return nil
				}
				continue
			}

			runnerMu.Lock()
			runner = nextRunner
			runnerMu.Unlock()

			go func(activeRunner awsSessionRunner) {
				for {
					select {
					case <-ctx.Done():
						return
					case event, ok := <-activeRunner.Events():
						if !ok {
							return
						}
						serverMessage := awsSessionServerMessage{Type: event.Type}
						if len(event.Data) > 0 {
							serverMessage.DataBase64 = base64.StdEncoding.EncodeToString(event.Data)
						}
						if strings.TrimSpace(event.Message) != "" {
							serverMessage.Message = event.Message
						}
						if !enqueue(serverMessage, event.Type == "exit") {
							return
						}
						if event.Type == "exit" {
							return
						}
					}
				}
			}(nextRunner)

		case "input":
			if activeRunner == nil {
				if !enqueue(awsSessionServerMessage{
					Type:    "error",
					Message: "AWS session is not started",
				}, false) {
					return nil
				}
				continue
			}
			data, err := base64.StdEncoding.DecodeString(message.DataBase64)
			if err != nil {
				if !enqueue(awsSessionServerMessage{
					Type:    "error",
					Message: "invalid input payload",
				}, false) {
					return nil
				}
				continue
			}
			if err := activeRunner.Write(data); err != nil {
				if !enqueue(awsSessionServerMessage{
					Type:    "error",
					Message: err.Error(),
				}, false) {
					return nil
				}
			}

		case "resize":
			if activeRunner == nil {
				if !enqueue(awsSessionServerMessage{
					Type:    "error",
					Message: "AWS session is not started",
				}, false) {
					return nil
				}
				continue
			}
			if err := activeRunner.Resize(message.Cols, message.Rows); err != nil {
				if !enqueue(awsSessionServerMessage{
					Type:    "error",
					Message: err.Error(),
				}, false) {
					return nil
				}
			}

		case "close":
			requestTeardown("client_close")
			return nil

		default:
			if !enqueue(awsSessionServerMessage{
				Type:    "error",
				Message: "unsupported AWS session websocket message type",
			}, false) {
				return nil
			}
		}
	}
}

func validateAwsSessionStartRequest(request awsSessionStartRequest) error {
	if strings.TrimSpace(request.HostID) == "" {
		return errors.New("missing host id")
	}
	if strings.TrimSpace(request.Label) == "" {
		return errors.New("missing host label")
	}
	if strings.TrimSpace(request.Region) == "" {
		return errors.New("missing AWS region")
	}
	if strings.TrimSpace(request.InstanceID) == "" {
		return errors.New("missing AWS instance id")
	}
	return nil
}

type lockedWebSocket struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

func (socket *lockedWebSocket) WriteJSON(value any, timeout time.Duration) error {
	socket.mu.Lock()
	defer socket.mu.Unlock()
	if err := socket.conn.SetWriteDeadline(time.Now().Add(timeout)); err != nil {
		return err
	}
	return socket.conn.WriteJSON(value)
}

func (socket *lockedWebSocket) WriteControl(messageType int, data []byte, timeout time.Duration) error {
	socket.mu.Lock()
	defer socket.mu.Unlock()
	return socket.conn.WriteControl(messageType, data, time.Now().Add(timeout))
}

func (socket *lockedWebSocket) Close() error {
	socket.mu.Lock()
	defer socket.mu.Unlock()
	return socket.conn.Close()
}

func closeAwsSessionRunner(runner awsSessionRunner, reason string) {
	if runner == nil {
		return
	}
	if reasonCloser, ok := runner.(awsSessionReasonCloser); ok {
		_ = reasonCloser.CloseWithReason(reason)
		return
	}
	_ = runner.Close()
}

func awsSessionTransportReason(err error) string {
	if err == nil {
		return "client_close"
	}
	if websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) || errors.Is(err, net.ErrClosed) {
		return "client_close"
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return "transport_timeout"
	}
	return "transport_error"
}
