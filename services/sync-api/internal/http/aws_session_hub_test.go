package http

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

type fakeAwsSessionRunner struct {
	events chan awsSessionRuntimeEvent

	mu           sync.Mutex
	writes       [][]byte
	resizeCalls  [][2]int
	closeCount   int
	closeReasons []string
	closeOnce    sync.Once
}

func newFakeAwsSessionRunner() *fakeAwsSessionRunner {
	return &fakeAwsSessionRunner{
		events: make(chan awsSessionRuntimeEvent, 16),
	}
}

func (runner *fakeAwsSessionRunner) Events() <-chan awsSessionRuntimeEvent {
	return runner.events
}

func (runner *fakeAwsSessionRunner) Write(data []byte) error {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	runner.writes = append(runner.writes, append([]byte(nil), data...))
	return nil
}

func (runner *fakeAwsSessionRunner) Resize(cols, rows int) error {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	runner.resizeCalls = append(runner.resizeCalls, [2]int{cols, rows})
	return nil
}

func (runner *fakeAwsSessionRunner) Close() error {
	return runner.CloseWithReason("client_close")
}

func (runner *fakeAwsSessionRunner) CloseWithReason(reason string) error {
	runner.closeOnce.Do(func() {
		runner.mu.Lock()
		runner.closeCount += 1
		runner.closeReasons = append(runner.closeReasons, reason)
		runner.mu.Unlock()
		close(runner.events)
	})
	return nil
}

func (runner *fakeAwsSessionRunner) writesSnapshot() [][]byte {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	result := make([][]byte, 0, len(runner.writes))
	for _, item := range runner.writes {
		result = append(result, append([]byte(nil), item...))
	}
	return result
}

func (runner *fakeAwsSessionRunner) resizeSnapshot() [][2]int {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	return append([][2]int(nil), runner.resizeCalls...)
}

func (runner *fakeAwsSessionRunner) closedCount() int {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	return runner.closeCount
}

func (runner *fakeAwsSessionRunner) closeReasonsSnapshot() []string {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	return append([]string(nil), runner.closeReasons...)
}

func TestAwsSessionHubReturns503WhenRuntimeIsUnavailable(t *testing.T) {
	hub := NewAwsSessionHub(AwsSsmRuntime{Enabled: false}, nil)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if err := hub.HandleWebSocket(writer, request); err != nil {
			t.Errorf("handle websocket: %v", err)
		}
	}))
	defer server.Close()

	response, err := http.Get(server.URL)
	if err != nil {
		t.Fatalf("get unavailable runtime response: %v", err)
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 for unavailable runtime, got %d", response.StatusCode)
	}
}

func TestAwsSessionHubBridgesStartInputResizeAndOutput(t *testing.T) {
	fakeRunner := newFakeAwsSessionRunner()
	var (
		mu           sync.Mutex
		startRequest awsSessionStartRequest
	)

	hub := NewAwsSessionHub(AwsSsmRuntime{Enabled: true}, func(_ AwsSsmRuntime, request awsSessionStartRequest) (awsSessionRunner, error) {
		mu.Lock()
		startRequest = request
		mu.Unlock()
		return fakeRunner, nil
	})

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if err := hub.HandleWebSocket(writer, request); err != nil {
			t.Errorf("handle websocket: %v", err)
		}
	}))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial websocket: %v", err)
	}
	defer conn.Close()

	if err := conn.WriteJSON(awsSessionClientMessage{
		Type: "start",
		Payload: &awsSessionStartRequest{
			HostID:      "host-aws-1",
			Label:       "Production EC2",
			ProfileName: "",
			Region:      "ap-northeast-2",
			InstanceID:  "i-0123456789",
			Cols:        132,
			Rows:        48,
			Env: map[string]string{
				"AWS_ACCESS_KEY_ID":     "AKIAFAKE",
				"AWS_SECRET_ACCESS_KEY": "fake-secret",
			},
			UnsetEnv: []string{"AWS_PROFILE"},
		},
	}); err != nil {
		t.Fatalf("write start message: %v", err)
	}

	fakeRunner.events <- awsSessionRuntimeEvent{Type: "ready"}

	var ready awsSessionServerMessage
	if err := conn.ReadJSON(&ready); err != nil {
		t.Fatalf("read ready message: %v", err)
	}
	if ready.Type != "ready" {
		t.Fatalf("expected ready message, got %#v", ready)
	}

	mu.Lock()
	if startRequest.HostID != "host-aws-1" || startRequest.InstanceID != "i-0123456789" {
		t.Fatalf("unexpected start request: %#v", startRequest)
	}
	mu.Unlock()

	outputText := "Connected to fake AWS SSM session.\r\n"
	fakeRunner.events <- awsSessionRuntimeEvent{
		Type: "output",
		Data: []byte(outputText),
	}

	var output awsSessionServerMessage
	if err := conn.ReadJSON(&output); err != nil {
		t.Fatalf("read output message: %v", err)
	}
	if output.Type != "output" {
		t.Fatalf("expected output message, got %#v", output)
	}
	decoded, err := base64.StdEncoding.DecodeString(output.DataBase64)
	if err != nil {
		t.Fatalf("decode output payload: %v", err)
	}
	if string(decoded) != outputText {
		t.Fatalf("unexpected output payload %q", string(decoded))
	}

	if err := conn.WriteJSON(awsSessionClientMessage{
		Type:       "input",
		DataBase64: base64.StdEncoding.EncodeToString([]byte("ls\r")),
	}); err != nil {
		t.Fatalf("write input message: %v", err)
	}
	waitForCondition(t, func() bool {
		writes := fakeRunner.writesSnapshot()
		return len(writes) == 1 && string(writes[0]) == "ls\r"
	})

	if err := conn.WriteJSON(awsSessionClientMessage{
		Type: "resize",
		Cols: 140,
		Rows: 40,
	}); err != nil {
		t.Fatalf("write resize message: %v", err)
	}
	waitForCondition(t, func() bool {
		resizeCalls := fakeRunner.resizeSnapshot()
		return len(resizeCalls) == 1 && resizeCalls[0] == [2]int{140, 40}
	})

	if err := conn.WriteJSON(awsSessionClientMessage{Type: "close"}); err != nil {
		t.Fatalf("write close message: %v", err)
	}
	waitForCondition(t, func() bool {
		return fakeRunner.closedCount() > 0
	})
}

func TestAwsSessionHubClosesRunnerOnAbruptDisconnect(t *testing.T) {
	fakeRunner := newFakeAwsSessionRunner()
	hub := NewAwsSessionHub(AwsSsmRuntime{Enabled: true}, func(_ AwsSsmRuntime, request awsSessionStartRequest) (awsSessionRunner, error) {
		return fakeRunner, nil
	})

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if err := hub.HandleWebSocket(writer, request); err != nil {
			t.Errorf("handle websocket: %v", err)
		}
	}))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial websocket: %v", err)
	}

	if err := conn.WriteJSON(awsSessionClientMessage{
		Type: "start",
		Payload: &awsSessionStartRequest{
			HostID:     "host-aws-1",
			Label:      "Production EC2",
			Region:     "ap-northeast-2",
			InstanceID: "i-0123456789",
		},
	}); err != nil {
		t.Fatalf("write start message: %v", err)
	}

	fakeRunner.events <- awsSessionRuntimeEvent{Type: "ready"}
	var ready awsSessionServerMessage
	if err := conn.ReadJSON(&ready); err != nil {
		t.Fatalf("read ready message: %v", err)
	}

	_ = conn.UnderlyingConn().Close()
	waitForCondition(t, func() bool {
		return fakeRunner.closedCount() == 1
	})
}

func TestAwsSessionHubTimesOutSilentConnections(t *testing.T) {
	fakeRunner := newFakeAwsSessionRunner()
	hub := NewAwsSessionHub(AwsSsmRuntime{Enabled: true}, func(_ AwsSsmRuntime, request awsSessionStartRequest) (awsSessionRunner, error) {
		return fakeRunner, nil
	})
	hub.pingInterval = 20 * time.Millisecond
	hub.pongWait = 60 * time.Millisecond
	hub.writeWait = 20 * time.Millisecond

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if err := hub.HandleWebSocket(writer, request); err != nil {
			t.Errorf("handle websocket: %v", err)
		}
	}))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial websocket: %v", err)
	}
	defer conn.Close()

	if err := conn.WriteJSON(awsSessionClientMessage{
		Type: "start",
		Payload: &awsSessionStartRequest{
			HostID:     "host-aws-1",
			Label:      "Production EC2",
			Region:     "ap-northeast-2",
			InstanceID: "i-0123456789",
		},
	}); err != nil {
		t.Fatalf("write start message: %v", err)
	}

	fakeRunner.events <- awsSessionRuntimeEvent{Type: "ready"}
	var ready awsSessionServerMessage
	if err := conn.ReadJSON(&ready); err != nil {
		t.Fatalf("read ready message: %v", err)
	}

	waitForCondition(t, func() bool {
		reasons := fakeRunner.closeReasonsSnapshot()
		return len(reasons) == 1 && reasons[0] == "transport_timeout"
	})
}

func waitForCondition(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition was not met before timeout")
}

func TestValidateAwsSessionStartRequest(t *testing.T) {
	valid := awsSessionStartRequest{
		HostID:     "host-1",
		Label:      "Production EC2",
		Region:     "ap-northeast-2",
		InstanceID: "i-0123456789",
	}
	if err := validateAwsSessionStartRequest(valid); err != nil {
		t.Fatalf("expected valid request, got %v", err)
	}

	cases := []awsSessionStartRequest{
		{Label: "x", Region: "ap-northeast-2", InstanceID: "i-1"},
		{HostID: "host-1", Region: "ap-northeast-2", InstanceID: "i-1"},
		{HostID: "host-1", Label: "x", InstanceID: "i-1"},
		{HostID: "host-1", Label: "x", Region: "ap-northeast-2"},
	}
	for _, testCase := range cases {
		if err := validateAwsSessionStartRequest(testCase); err == nil {
			payload, _ := json.Marshal(testCase)
			t.Fatalf("expected invalid start request for %s", payload)
		}
	}
}
