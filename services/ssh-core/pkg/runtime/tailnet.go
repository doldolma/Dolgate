package runtime

import (
	"errors"

	"dolssh/services/ssh-core/pkg/coretypes"
)

var errTailnetDisabled = errors.New("tailnet support is not enabled")

// TailnetTest preserves the desktop command contract while orchestration lives
// in the shared Tailnet service used by every platform runtime.
func (runtime *Runtime) TailnetTest(requestID string, payload coretypes.TailnetTestPayload) error {
	if runtime.tailnetService == nil {
		return errTailnetDisabled
	}
	return runtime.tailnetService.TailnetTest(requestID, payload)
}

func (runtime *Runtime) TailnetCancel(requestID string, payload coretypes.TailnetDisconnectPayload) error {
	if runtime.tailnetService == nil {
		return errTailnetDisabled
	}
	return runtime.tailnetService.TailnetCancel(requestID, payload)
}

func (runtime *Runtime) TailnetDisconnect(requestID string, payload coretypes.TailnetDisconnectPayload) error {
	if runtime.tailnetService == nil {
		return errTailnetDisabled
	}
	return runtime.tailnetService.TailnetDisconnect(requestID, payload)
}

func (runtime *Runtime) TailnetSnapshot(requestID string) error {
	if runtime.tailnetService == nil {
		return errTailnetDisabled
	}
	return runtime.tailnetService.TailnetSnapshot(requestID)
}

func (runtime *Runtime) TailnetConfigure(payload coretypes.TailnetConfigurePayload) error {
	if runtime.tailnetService == nil {
		return errTailnetDisabled
	}
	return runtime.tailnetService.TailnetConfigure(payload)
}

func (runtime *Runtime) TailnetForget(requestID string, payload coretypes.TailnetForgetPayload) error {
	if runtime.tailnetService == nil {
		return errTailnetDisabled
	}
	return runtime.tailnetService.TailnetForget(requestID, payload)
}

func (runtime *Runtime) shutdownTailnets() {
	if runtime.tailnetService == nil {
		return
	}
	_ = runtime.tailnetService.Close()
}
