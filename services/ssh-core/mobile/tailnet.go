package mobile

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"dolssh/services/ssh-core/internal/sshconn"
	"dolssh/services/ssh-core/internal/tailnet"
	"dolssh/services/ssh-core/internal/tailnetservice"
	"dolssh/services/ssh-core/pkg/coretypes"
)

// TailnetEventListener receives the same JSON events as the desktop stdio
// protocol. Keeping one event vocabulary lets the mobile app reuse status and
// recovery decisions without reproducing them in Swift, Kotlin, or TypeScript.
type TailnetEventListener interface {
	OnTailnetEvent(eventJSON string)
}

type mobileTailnetRuntime struct {
	stateDir string
	service  *tailnetservice.Service

	listenerMu sync.RWMutex
	listener   TailnetEventListener
}

// Mobile sessions hold a lease for as long as SSH/SFTP is alive. Once the last
// consumer leaves, keeping an idle userspace node for desktop's full 30-minute
// reuse window costs needless battery. The registration remains on disk, so a
// later connection can bring the same node identity back without logging in.
const mobileTailnetIdleGrace = 2 * time.Minute

func newMobileTailnetRuntime(stateDir string, listener TailnetEventListener) *mobileTailnetRuntime {
	runtime := &mobileTailnetRuntime{stateDir: stateDir, listener: listener}
	runtime.service = tailnetservice.New(tailnetservice.Options{
		StateDir:        stateDir,
		EmitEvent:       runtime.emit,
		RegistryOptions: tailnet.Options{IdleGrace: mobileTailnetIdleGrace},
	})
	return runtime
}

func (runtime *mobileTailnetRuntime) emit(event coretypes.Event) {
	encoded, err := json.Marshal(event)
	if err != nil {
		return
	}

	runtime.listenerMu.RLock()
	listener := runtime.listener
	runtime.listenerMu.RUnlock()
	if listener != nil {
		listener.OnTailnetEvent(string(encoded))
	}
}

func (runtime *mobileTailnetRuntime) setListener(listener TailnetEventListener) {
	runtime.listenerMu.Lock()
	runtime.listener = listener
	runtime.listenerMu.Unlock()
}

func (runtime *mobileTailnetRuntime) close() error {
	runtime.setListener(nil)
	return runtime.service.Close()
}

// ConfigureTailnets initializes the account-scoped Tailnet runtime and applies
// its complete configuration snapshot. stateRoot is supplied by the native app
// sandbox; stateScope identifies the signed-in server/account pair and is hashed
// before it becomes a directory name.
func (e *Engine) ConfigureTailnets(
	stateRoot string,
	stateScope string,
	configsJSON string,
	listener TailnetEventListener,
) error {
	stateDir, err := scopedTailnetStateDir(stateRoot, stateScope)
	if err != nil {
		return err
	}

	var payload coretypes.TailnetConfigurePayload
	if err := json.Unmarshal([]byte(configsJSON), &payload); err != nil {
		return fmt.Errorf("parse tailnet configuration: %w", err)
	}

	e.tailnetMu.Lock()
	current := e.tailnetRuntime
	if current != nil && current.stateDir == stateDir {
		current.setListener(listener)
		e.tailnetMu.Unlock()
		return current.service.TailnetConfigure(payload)
	}

	next := newMobileTailnetRuntime(stateDir, listener)
	if err := next.service.TailnetConfigure(payload); err != nil {
		e.tailnetMu.Unlock()
		_ = next.close()
		return err
	}
	e.tailnetRuntime = next
	e.tailnetMu.Unlock()

	if current != nil {
		_ = current.close()
	}
	return nil
}

// StartTailnet runs the shared bring-up/authentication state machine. Progress
// is delivered through TailnetEventListener and the call returns when the
// Tailnet is usable, cancelled, or reaches its timeout.
func (e *Engine) StartTailnet(requestID string, payloadJSON string) error {
	var payload coretypes.TailnetTestPayload
	if err := json.Unmarshal([]byte(payloadJSON), &payload); err != nil {
		return fmt.Errorf("parse tailnet start request: %w", err)
	}
	runtime, err := e.requireTailnetRuntime()
	if err != nil {
		return err
	}
	return runtime.service.TailnetTest(requestID, payload)
}

func (e *Engine) CancelTailnet(requestID string, id string) error {
	runtime, err := e.requireTailnetRuntime()
	if err != nil {
		return err
	}
	return runtime.service.TailnetCancel(requestID, coretypes.TailnetDisconnectPayload{ID: id})
}

func (e *Engine) DisconnectTailnet(requestID string, id string) error {
	runtime, err := e.requireTailnetRuntime()
	if err != nil {
		return err
	}
	return runtime.service.TailnetDisconnect(requestID, coretypes.TailnetDisconnectPayload{ID: id})
}

func (e *Engine) SnapshotTailnets(requestID string) error {
	runtime, err := e.requireTailnetRuntime()
	if err != nil {
		return err
	}
	return runtime.service.TailnetSnapshot(requestID)
}

// ForgetTailnet removes one local identity and asks the control plane to remove
// its node. Normal logout uses CloseTailnets instead so signing out does not
// consume a new node registration on the next login.
func (e *Engine) ForgetTailnet(id string) error {
	runtime, err := e.requireTailnetRuntime()
	if err != nil {
		return err
	}
	return runtime.service.TailnetForget(
		"mobile-forget-"+strings.TrimSpace(id),
		coretypes.TailnetForgetPayload{ID: id},
	)
}

// CloseTailnets stops all in-process nodes but preserves their local identities
// on disk. A later ConfigureTailnets call creates a fresh service instance.
func (e *Engine) CloseTailnets() error {
	e.tailnetMu.Lock()
	runtime := e.tailnetRuntime
	e.tailnetRuntime = nil
	e.tailnetMu.Unlock()

	if runtime == nil {
		return nil
	}
	return runtime.close()
}

func (e *Engine) requireTailnetRuntime() (*mobileTailnetRuntime, error) {
	e.tailnetMu.Lock()
	defer e.tailnetMu.Unlock()
	if e.tailnetRuntime == nil {
		return nil, errors.New("tailnet runtime is not configured")
	}
	return e.tailnetRuntime, nil
}

// resolveTailnetDial keeps direct connections untouched and resolves an
// explicitly requested Tailnet through the account-scoped mobile runtime.
// Missing runtime/configuration is an error: silently dialing the public
// network would violate the host's routing and known-host trust boundary.
func (e *Engine) resolveTailnetDial(id string, expectedName string) (sshconn.DialFunc, error) {
	if strings.TrimSpace(id) == "" {
		return nil, nil
	}

	e.tailnetMu.Lock()
	defer e.tailnetMu.Unlock()
	if e.tailnetRuntime == nil {
		return nil, errors.New("tailnet runtime is not configured")
	}
	return e.tailnetRuntime.service.Dial(tailnetservice.TailnetRoute{
		ID:           id,
		ExpectedName: expectedName,
	})
}

func scopedTailnetStateDir(stateRoot string, stateScope string) (string, error) {
	root := strings.TrimSpace(stateRoot)
	if root == "" {
		return "", errors.New("tailnet state root is required")
	}
	if !filepath.IsAbs(root) {
		return "", errors.New("tailnet state root must be absolute")
	}
	scope := strings.TrimSpace(stateScope)
	if scope == "" {
		return "", errors.New("tailnet state scope is required")
	}

	digest := sha256.Sum256([]byte(scope))
	return filepath.Join(root, hex.EncodeToString(digest[:])), nil
}
