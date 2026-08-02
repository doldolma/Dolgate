package runtime

import (
	"testing"

	"dolssh/services/ssh-core/internal/tailnetservice"
	"dolssh/services/ssh-core/pkg/coretypes"
)

func TestTailnetFacadeRejectsCommandsWhenDisabled(t *testing.T) {
	instance := &Runtime{}

	if err := instance.TailnetTest("req-test", coretypes.TailnetTestPayload{}); err == nil {
		t.Fatal("TailnetTest succeeded without a Tailnet service")
	}
	if err := instance.TailnetSnapshot("req-snapshot"); err == nil {
		t.Fatal("TailnetSnapshot succeeded without a Tailnet service")
	}
	if _, err := instance.tailnetDial(TailnetRoute{ID: "corp"}); err == nil {
		t.Fatal("tailnetDial succeeded without a Tailnet service")
	}
}

func TestTailnetFacadePreservesSnapshotEventContract(t *testing.T) {
	var events []coretypes.Event
	service := tailnetservice.New(tailnetservice.Options{
		StateDir: t.TempDir(),
		EmitEvent: func(event coretypes.Event) {
			events = append(events, event)
		},
	})
	t.Cleanup(func() { _ = service.Close() })
	instance := &Runtime{tailnetService: service}

	if err := instance.TailnetConfigure(coretypes.TailnetConfigurePayload{
		Configs: []coretypes.TailnetConfigPayload{{ID: "corp"}},
	}); err != nil {
		t.Fatalf("TailnetConfigure: %v", err)
	}
	if err := instance.TailnetSnapshot("req-snapshot"); err != nil {
		t.Fatalf("TailnetSnapshot: %v", err)
	}

	if len(events) != 1 {
		t.Fatalf("events = %d, want 1", len(events))
	}
	event := events[0]
	if event.Type != coretypes.EventTailnetSnapshot || event.RequestID != "req-snapshot" {
		t.Fatalf("event = %#v", event)
	}
	if _, ok := event.Payload.(coretypes.TailnetSnapshotPayload); !ok {
		t.Fatalf("payload type = %T, want TailnetSnapshotPayload", event.Payload)
	}
}
