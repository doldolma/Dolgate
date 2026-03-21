package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"

	"keyterm/services/ssh-core/internal/protocol"
	coresftp "keyterm/services/ssh-core/internal/sftp"
	"keyterm/services/ssh-core/internal/sshsession"
)

type eventWriter struct {
	// stdout에 여러 goroutine이 동시에 쓰지 않도록 직렬화한다.
	mu sync.Mutex
}

func newEventWriter() *eventWriter {
	return &eventWriter{}
}

func (w *eventWriter) emit(event protocol.Event) {
	w.mu.Lock()
	defer w.mu.Unlock()
	_ = protocol.WriteControlFrame(os.Stdout, event)
}

func (w *eventWriter) emitStream(metadata protocol.StreamFrame, payload []byte) {
	w.mu.Lock()
	defer w.mu.Unlock()
	_ = protocol.WriteStreamFrame(os.Stdout, metadata, payload)
}

func main() {
	// main은 "stdin에서 요청 읽기 -> SSH 세션 매니저 디스패치 -> stdout 이벤트 출력"만 담당한다.
	writer := newEventWriter()
	manager := sshsession.NewManager(writer.emit, writer.emitStream)
	sftpService := coresftp.New(writer.emit)
	defer sftpService.Shutdown()

	// 코어 기동 직후 ready 이벤트를 보내 Electron이 상태를 파악할 수 있게 한다.
	writer.emit(protocol.Event{
		Type: protocol.EventStatus,
		Payload: protocol.StatusPayload{
			Status:  "ready",
			Message: "ssh core ready",
		},
	})

	for {
		frame, err := protocol.ReadFrame(os.Stdin)
		if err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
				return
			}
			// framing이 깨진 경우에는 복구가 어려우므로 프로세스 수준 오류를 남기고 종료한다.
			writer.emit(protocol.Event{
				Type: protocol.EventError,
				Payload: protocol.ErrorPayload{
					Message: err.Error(),
				},
			})
			return
		}

		if err := dispatchFrame(manager, sftpService, writer, frame); err != nil {
			// 명령 단위 오류는 requestId/sessionId를 포함해 상위 레이어가 추적하기 쉽게 한다.
			eventType := protocol.EventError
			if isSFTPCommand(frame) {
				eventType = protocol.EventSFTPError
			}
			writer.emit(protocol.Event{
				Type:       eventType,
				RequestID:  frameRequestID(frame),
				SessionID:  frameSessionID(frame),
				EndpointID: frameEndpointID(frame),
				JobID:      frameJobID(frame),
				Payload: protocol.ErrorPayload{
					Message: err.Error(),
				},
			})
		}
	}
}

func dispatchFrame(manager *sshsession.Manager, sftpService *coresftp.Service, writer *eventWriter, frame protocol.Frame) error {
	if frame.Kind == protocol.FrameKindStream {
		var metadata protocol.StreamFrame
		if err := protocol.DecodeStreamFrame(frame, &metadata); err != nil {
			return fmt.Errorf("invalid stream frame: %w", err)
		}
		if metadata.Type != protocol.StreamTypeWrite {
			return fmt.Errorf("unsupported stream type: %s", metadata.Type)
		}
		return manager.WriteBytes(metadata.SessionID, frame.Payload)
	}

	var request protocol.Request
	if err := protocol.DecodeControlFrame(frame, &request); err != nil {
		return fmt.Errorf("invalid control frame: %w", err)
	}
	return dispatch(manager, sftpService, writer, request)
}

func dispatch(manager *sshsession.Manager, sftpService *coresftp.Service, writer *eventWriter, request protocol.Request) error {
	// payload 타입이 명령마다 다르기 때문에 여기서 명령별로 역직렬화한다.
	switch request.Type {
	case protocol.CommandHealth:
		writer.emit(protocol.Event{
			Type:      protocol.EventStatus,
			RequestID: request.ID,
			Payload: protocol.StatusPayload{
				Status:  "ok",
				Message: "ssh core healthy",
			},
		})
		return nil
	case protocol.CommandConnect:
		var payload protocol.ConnectPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return manager.Connect(request.SessionID, request.ID, payload)
	case protocol.CommandResize:
		var payload protocol.ResizePayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return manager.Resize(request.SessionID, payload.Cols, payload.Rows)
	case protocol.CommandDisconnect:
		return manager.Disconnect(request.SessionID)
	case protocol.CommandSFTPConnect:
		var payload protocol.SFTPConnectPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return sftpService.Connect(request.EndpointID, request.ID, payload)
	case protocol.CommandSFTPDisconnect:
		return sftpService.Disconnect(request.EndpointID, request.ID)
	case protocol.CommandSFTPList:
		var payload protocol.SFTPListPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return sftpService.List(request.EndpointID, request.ID, payload)
	case protocol.CommandSFTPMkdir:
		var payload protocol.SFTPMkdirPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return sftpService.Mkdir(request.EndpointID, request.ID, payload)
	case protocol.CommandSFTPRename:
		var payload protocol.SFTPRenamePayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return sftpService.Rename(request.EndpointID, request.ID, payload)
	case protocol.CommandSFTPDelete:
		var payload protocol.SFTPDeletePayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return sftpService.Delete(request.EndpointID, request.ID, payload)
	case protocol.CommandSFTPTransferStart:
		var payload protocol.SFTPTransferStartPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return sftpService.StartTransfer(request.JobID, payload)
	case protocol.CommandSFTPTransferCancel:
		return sftpService.CancelTransfer(request.JobID)
	default:
		return fmt.Errorf("unknown command type: %s", request.Type)
	}
}

func frameRequestID(frame protocol.Frame) string {
	if frame.Kind == protocol.FrameKindControl {
		var request protocol.Request
		if err := protocol.DecodeControlFrame(frame, &request); err == nil {
			return request.ID
		}
		return ""
	}
	var metadata protocol.StreamFrame
	if err := protocol.DecodeStreamFrame(frame, &metadata); err == nil {
		return metadata.RequestID
	}
	return ""
}

func frameSessionID(frame protocol.Frame) string {
	if frame.Kind == protocol.FrameKindControl {
		var request protocol.Request
		if err := protocol.DecodeControlFrame(frame, &request); err == nil {
			return request.SessionID
		}
		return ""
	}
	var metadata protocol.StreamFrame
	if err := protocol.DecodeStreamFrame(frame, &metadata); err == nil {
		return metadata.SessionID
	}
	return ""
}

func frameEndpointID(frame protocol.Frame) string {
	if frame.Kind != protocol.FrameKindControl {
		return ""
	}
	var request protocol.Request
	if err := protocol.DecodeControlFrame(frame, &request); err == nil {
		return request.EndpointID
	}
	return ""
}

func frameJobID(frame protocol.Frame) string {
	if frame.Kind != protocol.FrameKindControl {
		return ""
	}
	var request protocol.Request
	if err := protocol.DecodeControlFrame(frame, &request); err == nil {
		return request.JobID
	}
	return ""
}

func isSFTPCommand(frame protocol.Frame) bool {
	if frame.Kind != protocol.FrameKindControl {
		return false
	}
	var request protocol.Request
	if err := protocol.DecodeControlFrame(frame, &request); err != nil {
		return false
	}
	switch request.Type {
	case protocol.CommandSFTPConnect,
		protocol.CommandSFTPDisconnect,
		protocol.CommandSFTPList,
		protocol.CommandSFTPMkdir,
		protocol.CommandSFTPRename,
		protocol.CommandSFTPDelete,
		protocol.CommandSFTPTransferStart,
		protocol.CommandSFTPTransferCancel:
		return true
	default:
		return false
	}
}
