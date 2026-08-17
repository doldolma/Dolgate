package mobile

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"dolssh/services/ssh-core/mobile/internal/sshtest"
	"dolssh/services/ssh-core/pkg/coretypes"
)

// These cover what mobile could not do before: connect to a host that asks for a
// verification code, and decide about a host key from inside the connection that
// presented it. Both come from routing this engine through internal/sshdial —
// the path the desktop uses — rather than assembling a config of its own here.

// eventSink collects the events a connection raises and lets a test wait for one.
type eventSink struct {
	mu     sync.Mutex
	events []coretypes.Event
	waits  []chan coretypes.Event
}

func (sink *eventSink) OnConnectionEvent(eventJSON string) {
	var event coretypes.Event
	if err := json.Unmarshal([]byte(eventJSON), &event); err != nil {
		return
	}
	sink.mu.Lock()
	sink.events = append(sink.events, event)
	waits := sink.waits
	sink.waits = nil
	sink.mu.Unlock()
	for _, wait := range waits {
		wait <- event
	}
}

// await returns the first event of this type, whether it has already arrived or
// arrives while waiting. Only looking forward would be a race: the connection
// raises its question as soon as it reaches it, which can be before the test
// starts waiting.
func (sink *eventSink) await(t *testing.T, eventType coretypes.EventType) coretypes.Event {
	t.Helper()
	deadline := time.After(15 * time.Second)
	for {
		sink.mu.Lock()
		for _, event := range sink.events {
			if event.Type == eventType {
				sink.mu.Unlock()
				return event
			}
		}
		wait := make(chan coretypes.Event, 8)
		sink.waits = append(sink.waits, wait)
		sink.mu.Unlock()

		select {
		case <-wait:
			// Loop and re-scan: the event that woke us may not be the one wanted.
		case <-deadline:
			sink.mu.Lock()
			seen := make([]string, 0, len(sink.events))
			for _, event := range sink.events {
				seen = append(seen, string(event.Type))
			}
			sink.mu.Unlock()
			t.Fatalf("no %s event; saw [%s]", eventType, strings.Join(seen, " "))
			return coretypes.Event{}
		}
	}
}

func (sink *eventSink) count(eventType coretypes.EventType) int {
	sink.mu.Lock()
	defer sink.mu.Unlock()
	total := 0
	for _, event := range sink.events {
		if event.Type == eventType {
			total += 1
		}
	}
	return total
}

// payloadOf re-decodes an event payload into a struct. The sink decodes into
// coretypes.Event, whose Payload is any, so it arrives as a map.
func payloadOf[T any](t *testing.T, event coretypes.Event) T {
	t.Helper()
	raw, err := json.Marshal(event.Payload)
	if err != nil {
		t.Fatalf("encode payload: %v", err)
	}
	var out T
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	return out
}

func newEngineWithSink(t *testing.T) (*Engine, *eventSink) {
	t.Helper()
	engine := NewEngine()
	sink := &eventSink{}
	engine.SetConnectionEventListener(sink)
	return engine, sink
}

func otpServer(t *testing.T, options sshtest.Options) *sshtest.Server {
	t.Helper()
	server, err := sshtest.NewServerWithOptions(options)
	if err != nil {
		t.Fatalf("start fixture: %v", err)
	}
	t.Cleanup(func() { _ = server.Close() })
	return server
}

func respondJSON(t *testing.T, payload coretypes.KeyboardInteractiveRespondPayload) string {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("encode response: %v", err)
	}
	return string(raw)
}

// The one that mattered: a host asking for a code was unreachable from mobile,
// because Connect took a responder no bridge implemented and both passed nil.
func TestConnectAsksForTheVerificationCode(t *testing.T) {
	server := otpServer(t, sshtest.Options{OTPCode: "246810"})
	engine, sink := newEngineWithSink(t)

	type result struct {
		conn *Conn
		err  error
	}
	results := make(chan result, 1)
	go func() {
		conn, err := engine.Connect(requestJSON(t, server.ConnectPayload()), nil)
		results <- result{conn: conn, err: err}
	}()

	event := sink.await(t, coretypes.EventKeyboardInteractiveChallenge)
	challenge := payloadOf[coretypes.KeyboardInteractiveChallengePayload](t, event)

	// The saved password answered its own round, so only the code reaches here.
	// Without that, a person would be typing a password they already stored.
	if len(challenge.Prompts) != 1 {
		t.Fatalf("prompts = %d, want 1", len(challenge.Prompts))
	}
	prompt := challenge.Prompts[0]
	if prompt.Label != "Verification code:" {
		t.Errorf("asked for %q, want the code round", prompt.Label)
	}
	// A code is shown as it is typed on purpose: it is copied from another device,
	// and hiding it causes the mistake masking was meant to prevent.
	if prompt.Masked {
		t.Error("the verification code was masked")
	}
	if prompt.AllowStoredPassword {
		t.Error("the saved password was offered for the verification code")
	}
	if event.SessionID != "conn-1" {
		t.Errorf("event sessionId = %q, want the connection handle", event.SessionID)
	}

	if err := engine.RespondKeyboardInteractive(respondJSON(t, coretypes.KeyboardInteractiveRespondPayload{
		ChallengeID: challenge.ChallengeID,
		Responses:   []string{"246810"},
	})); err != nil {
		t.Fatalf("respond: %v", err)
	}

	got := <-results
	if got.err != nil {
		t.Fatalf("connect: %v", got.err)
	}
	t.Cleanup(func() { _ = got.conn.Close() })

	if asked := sink.count(coretypes.EventKeyboardInteractiveChallenge); asked != 1 {
		t.Errorf("the person was asked %d times, want 1", asked)
	}
}

// The saved password is filled in by the engine, from the index the app named.
//
// Two things are checked at once, and both matter. The value never leaves the
// engine — the app answers with a position — and the choice of position is the
// app's, because a server that writes `Password:` while asking for a second
// factor would otherwise be handed the password, and SSH allows one attempt per
// method: that mistake ends the connection.
func TestConnectFillsTheSavedPasswordByIndex(t *testing.T) {
	server := otpServer(t, sshtest.Options{OTPCode: "135791", CombinedPrompts: true})
	engine, sink := newEngineWithSink(t)

	errs := make(chan error, 1)
	go func() {
		conn, err := engine.Connect(requestJSON(t, server.ConnectPayload()), nil)
		if conn != nil {
			_ = conn.Close()
		}
		errs <- err
	}()

	challenge := payloadOf[coretypes.KeyboardInteractiveChallengePayload](
		t, sink.await(t, coretypes.EventKeyboardInteractiveChallenge),
	)
	if len(challenge.Prompts) != 2 {
		t.Fatalf("prompts = %d, want the password and the code together", len(challenge.Prompts))
	}
	if !challenge.HasStoredPassword {
		t.Error("hasStoredPassword is false although the request carried one")
	}
	// The engine judges per prompt: the password field may be filled from the
	// saved value, the code field may not.
	if !challenge.Prompts[0].AllowStoredPassword {
		t.Error("the saved password was not offered for the password field")
	}
	if challenge.Prompts[1].AllowStoredPassword {
		t.Error("the saved password was offered for the verification code")
	}

	// The password field is answered with nothing but its index.
	if err := engine.RespondKeyboardInteractive(respondJSON(t, coretypes.KeyboardInteractiveRespondPayload{
		ChallengeID:           challenge.ChallengeID,
		Responses:             []string{"", "135791"},
		StoredPasswordIndexes: []int{0},
	})); err != nil {
		t.Fatalf("respond: %v", err)
	}

	// Authenticating proves the engine substituted it: the fixture rejects the
	// round unless the first field holds the real password.
	if err := <-errs; err != nil {
		t.Fatalf("connect: %v", err)
	}
}

// Dismissing the sheet has to be told. Saying nothing leaves the connection on
// its budget with nobody coming, and on a tailnet route it holds that node's
// lease for the whole wait.
func TestCancelledChallengeEndsTheConnect(t *testing.T) {
	server := otpServer(t, sshtest.Options{OTPCode: "112233"})
	engine, sink := newEngineWithSink(t)

	errs := make(chan error, 1)
	go func() {
		conn, err := engine.Connect(requestJSON(t, server.ConnectPayload()), nil)
		if conn != nil {
			_ = conn.Close()
		}
		errs <- err
	}()

	challenge := payloadOf[coretypes.KeyboardInteractiveChallengePayload](
		t, sink.await(t, coretypes.EventKeyboardInteractiveChallenge),
	)
	if err := engine.RespondKeyboardInteractive(respondJSON(t, coretypes.KeyboardInteractiveRespondPayload{
		ChallengeID: challenge.ChallengeID,
		Cancelled:   true,
	})); err != nil {
		t.Fatalf("cancel: %v", err)
	}

	select {
	case err := <-errs:
		if err == nil {
			t.Fatal("the connect succeeded after the prompt was dismissed")
		}
	case <-time.After(15 * time.Second):
		t.Fatal("the connect kept waiting after the prompt was dismissed")
	}
}

// The banner reaches the app while the connection is still open. Reported after a
// failure it is useless: some servers use it to say "approve this elsewhere", and
// by then there is nothing left to approve.
func TestBannerReachesTheAppDuringTheConnect(t *testing.T) {
	const text = "Approve this login at https://example.com/approve"
	server := otpServer(t, sshtest.Options{Banner: text})
	engine, sink := newEngineWithSink(t)

	conn, err := engine.Connect(requestJSON(t, server.ConnectPayload()), nil)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })

	banner := payloadOf[coretypes.SSHBannerPayload](t, sink.await(t, coretypes.EventSSHBanner))
	if banner.Text != text {
		t.Errorf("banner = %q, want %q", banner.Text, text)
	}
}

// Trust is decided inside the connection that presented the key. The probe this
// replaces was a second connection and key exchange — and on an OTP host it asked
// for a code of its own, which had rotated by the time the real connect asked.
func TestUnknownHostKeyIsAskedAboutInsideTheConnection(t *testing.T) {
	server := otpServer(t, sshtest.Options{})
	engine, sink := newEngineWithSink(t)

	payload := server.ConnectPayload()
	payload.TrustedHostKeyBase64 = ""
	payload.TrustedHostKeysBase64 = nil

	errs := make(chan error, 1)
	conns := make(chan *Conn, 1)
	go func() {
		conn, err := engine.Connect(requestJSON(t, payload), nil)
		conns <- conn
		errs <- err
	}()

	challenge := payloadOf[coretypes.HostKeyTrustChallengePayload](
		t, sink.await(t, coretypes.EventHostKeyTrustChallenge),
	)
	if challenge.PublicKeyBase64 != server.HostKeyBase64() {
		t.Errorf("asked about %q, want the fixture's host key", challenge.PublicKeyBase64)
	}
	if challenge.Mismatch {
		t.Error("mismatch is true for a host with nothing on file")
	}
	if challenge.FingerprintSHA256 == "" {
		t.Error("no fingerprint to show")
	}
	// Which server presented it. In a jump chain this is how the app knows not to
	// file a bastion's key against the host behind it.
	if challenge.Hop == nil || challenge.Hop.Port != server.Port() {
		t.Errorf("hop = %+v, want the fixture's address", challenge.Hop)
	}

	if err := engine.RespondHostKeyTrust(challenge.ChallengeID, true); err != nil {
		t.Fatalf("respond: %v", err)
	}

	if err := <-errs; err != nil {
		t.Fatalf("connect: %v", err)
	}
	if conn := <-conns; conn != nil {
		_ = conn.Close()
	}
}

func TestDeclinedHostKeyEndsTheConnect(t *testing.T) {
	server := otpServer(t, sshtest.Options{})
	engine, sink := newEngineWithSink(t)

	payload := server.ConnectPayload()
	payload.TrustedHostKeyBase64 = ""
	payload.TrustedHostKeysBase64 = nil

	errs := make(chan error, 1)
	go func() {
		conn, err := engine.Connect(requestJSON(t, payload), nil)
		if conn != nil {
			_ = conn.Close()
		}
		errs <- err
	}()

	challenge := payloadOf[coretypes.HostKeyTrustChallengePayload](
		t, sink.await(t, coretypes.EventHostKeyTrustChallenge),
	)
	if err := engine.RespondHostKeyTrust(challenge.ChallengeID, false); err != nil {
		t.Fatalf("respond: %v", err)
	}

	select {
	case err := <-errs:
		if err == nil {
			t.Fatal("connected to a host whose key was declined")
		}
	case <-time.After(15 * time.Second):
		t.Fatal("the connect kept waiting after the key was declined")
	}
}

// A key that is not the one on file is a question too, not a bare failure: it may
// have rotated, dropped an algorithm, or be another machine — only the person can
// tell. Before this, mobile ended the connect and probed again to ask.
func TestChangedHostKeyIsAskedAboutAsAMismatch(t *testing.T) {
	server := otpServer(t, sshtest.Options{})
	engine, sink := newEngineWithSink(t)

	payload := server.ConnectPayload()
	// A well-formed key that is not this server's.
	payload.TrustedHostKeyBase64 = ""
	payload.TrustedHostKeysBase64 = []string{staleHostKey(t)}

	errs := make(chan error, 1)
	conns := make(chan *Conn, 1)
	go func() {
		conn, err := engine.Connect(requestJSON(t, payload), nil)
		conns <- conn
		errs <- err
	}()

	challenge := payloadOf[coretypes.HostKeyTrustChallengePayload](
		t, sink.await(t, coretypes.EventHostKeyTrustChallenge),
	)
	if !challenge.Mismatch {
		t.Error("mismatch is false although a different key was on file")
	}
	if err := engine.RespondHostKeyTrust(challenge.ChallengeID, true); err != nil {
		t.Fatalf("respond: %v", err)
	}

	if err := <-errs; err != nil {
		t.Fatalf("connect: %v", err)
	}
	if conn := <-conns; conn != nil {
		_ = conn.Close()
	}
}

// Cutting a connect that is still being opened. disconnect cannot do it: it
// closes a registered connection, and one that is still dialing was never
// registered anywhere the app can reach.
func TestCancelConnectReleasesAWaitingPrompt(t *testing.T) {
	server := otpServer(t, sshtest.Options{OTPCode: "445566"})
	engine, sink := newEngineWithSink(t)

	errs := make(chan error, 1)
	go func() {
		conn, err := engine.Connect(requestJSON(t, server.ConnectPayload()), nil)
		if conn != nil {
			_ = conn.Close()
		}
		errs <- err
	}()

	sink.await(t, coretypes.EventKeyboardInteractiveChallenge)
	engine.CancelConnect("conn-1")

	select {
	case err := <-errs:
		if err == nil {
			t.Fatal("the connect succeeded after being cancelled")
		}
	case <-time.After(15 * time.Second):
		t.Fatal("cancelling did not release the waiting prompt")
	}
}

// Answering a challenge nobody is waiting for has to be an error rather than a
// silent no-op: on the app side that is the difference between "the sheet is
// stale" and "your answer went nowhere and the connection is still waiting".
func TestRespondingToAnUnknownChallengeFails(t *testing.T) {
	engine, _ := newEngineWithSink(t)

	err := engine.RespondKeyboardInteractive(respondJSON(t, coretypes.KeyboardInteractiveRespondPayload{
		ChallengeID: "conn-1-1",
		Responses:   []string{"nobody is listening"},
	}))
	if err == nil {
		t.Fatal("responding to a challenge that does not exist reported success")
	}
	if trustErr := engine.RespondHostKeyTrust("hostkey-trust-9", true); trustErr == nil {
		t.Fatal("trusting a challenge that does not exist reported success")
	}
}

// A connect with no listener must not wait on questions nobody can see. That is
// the rule the desktop follows for its probe path, and it is why the app can run
// a background reconnect without a sheet appearing out of nowhere.
func TestConnectWithoutAListenerDoesNotWaitForAnAnswer(t *testing.T) {
	server := otpServer(t, sshtest.Options{OTPCode: "778899"})
	engine := NewEngine()

	errs := make(chan error, 1)
	go func() {
		conn, err := engine.Connect(requestJSON(t, server.ConnectPayload()), nil)
		if conn != nil {
			_ = conn.Close()
		}
		errs <- err
	}()

	select {
	case err := <-errs:
		if err == nil {
			t.Fatal("connected to an OTP host with nowhere to ask for the code")
		}
	case <-time.After(20 * time.Second):
		t.Fatal("the connect waited for an answer with no listener to ask")
	}
}

// staleHostKey is a valid host key that is not the fixture's, for driving the
// "a different key arrived" path.
func staleHostKey(t *testing.T) string {
	t.Helper()
	other, err := sshtest.NewServer()
	if err != nil {
		t.Fatalf("start a second fixture: %v", err)
	}
	key := other.HostKeyBase64()
	if err := other.Close(); err != nil {
		t.Fatalf("close the second fixture: %v", err)
	}
	if key == "" {
		t.Fatal(fmt.Errorf("the second fixture reported no host key"))
	}
	return key
}
