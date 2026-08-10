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

// TailnetForwardOpen 은 tailnet 안의 한 곳으로 이어 줄 로컬 포워드를 연다.
//
// RDP(Rust 코어)가 tailnet 을 직접 쓸 수 없어서 필요하다 — 여기서 만든 로컬 주소로 붙는다.
func (runtime *Runtime) TailnetForwardOpen(
	requestID string,
	payload coretypes.TailnetForwardOpenPayload,
) error {
	if runtime.tailnetService == nil {
		return errTailnetDisabled
	}
	return runtime.tailnetService.TailnetForwardOpen(requestID, payload)
}

func (runtime *Runtime) TailnetForwardClose(payload coretypes.TailnetForwardClosePayload) error {
	if runtime.tailnetService == nil {
		return errTailnetDisabled
	}
	return runtime.tailnetService.TailnetForwardClose(payload)
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
