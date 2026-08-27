package runtime

import (
	"encoding/json"
	"runtime"
	"testing"

	"dolssh/services/ssh-core/pkg/coretypes"
)

func collectHostMetricsPayload(
	t *testing.T,
	local *stubLocalManager,
	sessionID string,
) coretypes.HostMetricsResultPayload {
	t.Helper()
	var payload coretypes.HostMetricsResultPayload
	var results, errorsEmitted int
	core := newRuntimeWithDeps(
		func(event coretypes.Event) {
			switch event.Type {
			case coretypes.EventHostMetricsResult:
				results++
				payload = event.Payload.(coretypes.HostMetricsResultPayload)
			case coretypes.EventError:
				errorsEmitted++
			}
		},
		func(coretypes.StreamFrame, []byte) {},
		&stubSSHManager{},
		&stubMoshManager{},
		&stubAWSManager{},
		local,
		&stubSerialManager{},
		&stubSFTPService{},
		&stubContainersService{},
		&stubForwardingService{},
		&stubSSMForwardingService{},
		nil,
		nil,
	)
	if err := core.CollectHostMetrics(sessionID, "req-1", 0, true); err != nil {
		t.Fatalf("CollectHostMetrics() error = %v", err)
	}
	// 지표 폴링 하나가 세션 오류를 올리면 터미널이 통째로 내려간다.
	if errorsEmitted != 0 {
		t.Fatalf("expected no session error events, got %d", errorsEmitted)
	}
	if results != 1 {
		t.Fatalf("expected exactly one result event, got %d", results)
	}
	return payload
}

// 원격 세션에 답하면 **이 기계의 숫자를 저쪽 것이라고 말하게 된다.** 로컬만 답한다.
func TestCollectHostMetricsRefusesNonLocalSessions(t *testing.T) {
	payload := collectHostMetricsPayload(t, &stubLocalManager{hasSession: false}, "session-ssh")
	if payload.Supported {
		t.Error("a non-local session must not be answered natively")
	}
	if len(payload.Sample) != 0 {
		t.Errorf("no sample should be attached, got %s", payload.Sample)
	}
}

func TestCollectHostMetricsAnswersLocalSessions(t *testing.T) {
	payload := collectHostMetricsPayload(t, &stubLocalManager{hasSession: true}, "session-local")
	if runtime.GOOS != "windows" {
		// 유닉스는 네이티브 수집을 하지 않는다 — 호출자는 셸 경로로 돌아가야 한다.
		if payload.Supported {
			t.Errorf("native collection is windows-only, got supported on %s", runtime.GOOS)
		}
		return
	}
	if !payload.Supported {
		t.Fatalf("local session went unanswered: %+v", payload)
	}
	var sample struct {
		Kind       string `json:"kind"`
		MemTotalKb *uint64
		System     *struct{ Hostname string }
	}
	if err := json.Unmarshal(payload.Sample, &sample); err != nil {
		t.Fatalf("sample is not readable JSON: %v", err)
	}
	// 렌더러가 이 표식으로 문서를 알아본다.
	if sample.Kind != "host-metrics-v1" {
		t.Errorf("kind = %q", sample.Kind)
	}
	if sample.MemTotalKb == nil || *sample.MemTotalKb == 0 {
		t.Error("sample carries no memory reading")
	}
	if sample.System == nil || sample.System.Hostname == "" {
		t.Error("system info was requested but did not come back")
	}
}
