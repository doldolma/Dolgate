package http

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"

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

type awsSessionRunnerFactory func(AwsSsmRuntime, awsSessionStartRequest) (awsSessionRunner, error)

type AwsSessionHub struct {
	runtime  AwsSsmRuntime
	upgrader websocket.Upgrader
	factory  awsSessionRunnerFactory
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
		factory: factory,
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

	var runner awsSessionRunner
	defer func() {
		if runner != nil {
			_ = runner.Close()
		}
	}()

	for {
		_, payload, err := conn.ReadMessage()
		if err != nil {
			return nil
		}

		var message awsSessionClientMessage
		if err := json.Unmarshal(payload, &message); err != nil {
			_ = socket.WriteJSON(awsSessionServerMessage{
				Type:    "error",
				Message: "invalid AWS session websocket payload",
			})
			continue
		}

		switch message.Type {
		case "start":
			if runner != nil {
				_ = socket.WriteJSON(awsSessionServerMessage{
					Type:    "error",
					Message: "AWS session already started",
				})
				continue
			}
			if message.Payload == nil {
				_ = socket.WriteJSON(awsSessionServerMessage{
					Type:    "error",
					Message: "missing start payload",
				})
				continue
			}
			if validationError := validateAwsSessionStartRequest(*message.Payload); validationError != nil {
				_ = socket.WriteJSON(awsSessionServerMessage{
					Type:    "error",
					Message: validationError.Error(),
				})
				continue
			}

			nextRunner, err := hub.factory(hub.runtime, *message.Payload)
			if err != nil {
				_ = socket.WriteJSON(awsSessionServerMessage{
					Type:    "error",
					Message: err.Error(),
				})
				continue
			}
			runner = nextRunner

			go func(activeRunner awsSessionRunner) {
				for event := range activeRunner.Events() {
					serverMessage := awsSessionServerMessage{Type: event.Type}
					if len(event.Data) > 0 {
						serverMessage.DataBase64 = base64.StdEncoding.EncodeToString(event.Data)
					}
					if strings.TrimSpace(event.Message) != "" {
						serverMessage.Message = event.Message
					}
					if err := socket.WriteJSON(serverMessage); err != nil {
						_ = activeRunner.Close()
						return
					}
					if event.Type == "exit" {
						_ = socket.Close()
						return
					}
				}
			}(runner)

		case "input":
			if runner == nil {
				_ = socket.WriteJSON(awsSessionServerMessage{
					Type:    "error",
					Message: "AWS session is not started",
				})
				continue
			}
			data, err := base64.StdEncoding.DecodeString(message.DataBase64)
			if err != nil {
				_ = socket.WriteJSON(awsSessionServerMessage{
					Type:    "error",
					Message: "invalid input payload",
				})
				continue
			}
			if err := runner.Write(data); err != nil {
				_ = socket.WriteJSON(awsSessionServerMessage{
					Type:    "error",
					Message: err.Error(),
				})
			}

		case "resize":
			if runner == nil {
				_ = socket.WriteJSON(awsSessionServerMessage{
					Type:    "error",
					Message: "AWS session is not started",
				})
				continue
			}
			if err := runner.Resize(message.Cols, message.Rows); err != nil {
				_ = socket.WriteJSON(awsSessionServerMessage{
					Type:    "error",
					Message: err.Error(),
				})
			}

		case "close":
			return nil

		default:
			_ = socket.WriteJSON(awsSessionServerMessage{
				Type:    "error",
				Message: "unsupported AWS session websocket message type",
			})
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

func (socket *lockedWebSocket) WriteJSON(value any) error {
	socket.mu.Lock()
	defer socket.mu.Unlock()
	return socket.conn.WriteJSON(value)
}

func (socket *lockedWebSocket) Close() error {
	socket.mu.Lock()
	defer socket.mu.Unlock()
	return socket.conn.Close()
}
