package sftp

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	sftppkg "github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"

	"dolssh/services/ssh-core/internal/hostkeytrust"
	"dolssh/services/ssh-core/internal/inflight"
	"dolssh/services/ssh-core/internal/protocol"
	"dolssh/services/ssh-core/internal/sftpedit"
	"dolssh/services/ssh-core/internal/sshcmd"
	"dolssh/services/ssh-core/internal/sshconn"
)

// EventEmitter는 SFTP 상태와 전송 이벤트를 상위 레이어로 올리는 함수다.
type EventEmitter func(protocol.Event)

type endpointHandle struct {
	client       *ssh.Client
	sftp         *sftppkg.Client
	rootPath     string
	sudoStatus   string
	sudoPassword string
	closer       sync.Once
}

type transferHandle struct {
	cancel          context.CancelFunc
	pauseController *transferPauseController
	progress        *transferProgress
	reporter        *transferProgressReporter
	cleanup         *transferCleanupTracker
}

type pendingChallenge struct {
	endpointID string
	responses  chan []string
}

type Service struct {
	mu                sync.RWMutex
	endpoints         map[string]*endpointHandle
	transfers         map[string]*transferHandle
	pendingChallenges map[string]*pendingChallenge
	emit              EventEmitter
	tailnetDial       sshconn.TailnetDialResolver
	// starting 은 아직 붙는 중인 연결을 대상별로 들고 있다 — 정지·종료가 그것을 끊을 수 있게 한다.
	// 사람의 답을 기다리는 구간은 대기표를 닫아 풀지만, dial·핸드셰이크처럼 기계를 기다리는 구간은
	// ctx 취소만이 끊는다.
	starting *inflight.Registry
	// hostKeyTrustPrompt 는 연결 중 신뢰를 묻는 창구다(런타임이 주입한다).
	hostKeyTrustPrompt func(ctx context.Context, correlation hostkeytrust.Correlation) sshconn.HostKeyTrustFunc
}

// SetTailnetDial 은 tailnet 경로를 raw dialer 로 바꾸는 함수를 주입한다.
//
// 생성자에서 받지 않는 이유는 tailnet 레지스트리가 런타임 소유이고, 서비스가 런타임보다 먼저
// 만들어지기 때문이다. coreManager.setSsmPortForwardTokenIssuer 와 같은 방식이다.
func (s *Service) SetTailnetDial(resolve sshconn.TailnetDialResolver) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tailnetDial = resolve
}

// SetHostKeyTrustPrompt 는 연결 중 신뢰 질의 창구를 주입한다.
//
// 생성자에서 받지 않는 이유는 대기표가 런타임 소유이고, 서비스가 런타임보다 먼저 만들어지기
// 때문이다(SetTailnetDial 과 같은 이유).
func (s *Service) SetHostKeyTrustPrompt(
	prompt func(ctx context.Context, correlation hostkeytrust.Correlation) sshconn.HostKeyTrustFunc,
) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.hostKeyTrustPrompt = prompt
}

// hostKeyTrust 는 이 연결의 질의 함수를 만든다. 창구가 없으면 nil — 그때는 신뢰되지 않은 키에서
// 예전처럼 연결이 끝난다.
func (s *Service) hostKeyTrust(
	ctx context.Context,
	correlation hostkeytrust.Correlation,
) sshconn.HostKeyTrustFunc {
	s.mu.RLock()
	prompt := s.hostKeyTrustPrompt
	s.mu.RUnlock()
	if prompt == nil {
		return nil
	}
	return prompt(ctx, correlation)
}

// tailnetDialer 는 이 연결에 쓸 dialer 를 만든다. 경로가 없으면 nil 이라 평소대로 나간다.
func (s *Service) tailnetDialer(tailnetID, expectedName string) (sshconn.DialFunc, error) {
	s.mu.RLock()
	resolve := s.tailnetDial
	s.mu.RUnlock()
	return sshconn.ResolveTailnetDial(resolve, tailnetID, expectedName)
}

func New(emit EventEmitter) *Service {
	return &Service{
		endpoints:         make(map[string]*endpointHandle),
		transfers:         make(map[string]*transferHandle),
		pendingChallenges: make(map[string]*pendingChallenge),
		starting:          inflight.New(),
		emit:              emit,
	}
}

func (s *Service) Shutdown() {
	s.mu.Lock()
	transfers := make([]*transferHandle, 0, len(s.transfers))
	for _, handle := range s.transfers {
		transfers = append(transfers, handle)
	}
	s.transfers = make(map[string]*transferHandle)

	endpoints := make([]*endpointHandle, 0, len(s.endpoints))
	for _, handle := range s.endpoints {
		endpoints = append(endpoints, handle)
	}
	s.endpoints = make(map[string]*endpointHandle)

	challenges := make([]*pendingChallenge, 0, len(s.pendingChallenges))
	for _, challenge := range s.pendingChallenges {
		challenges = append(challenges, challenge)
	}
	s.pendingChallenges = make(map[string]*pendingChallenge)
	s.mu.Unlock()

	for _, handle := range transfers {
		handle.cancel()
	}
	for _, handle := range endpoints {
		handle.close()
	}
	for _, challenge := range challenges {
		close(challenge.responses)
	}
}

func (s *Service) Connect(endpointID, requestID string, payload protocol.SFTPConnectPayload) error {
	// 붙는 동안 연결을 닫으면 이 ctx 가 취소돼 dial·핸드셰이크가 즉시 끝난다.
	ctx, release := s.starting.Begin(endpointID)
	defer release()

	attempt := 0
	target := sshconn.Target{
		Host:                  payload.Host,
		Port:                  payload.Port,
		Username:              payload.Username,
		AuthType:              payload.AuthType,
		Password:              payload.Password,
		PrivateKeyPEM:         payload.PrivateKeyPEM,
		CertificateText:       payload.CertificateText,
		Passphrase:            payload.Passphrase,
		TrustedHostKeyBase64:  payload.TrustedHostKeyBase64,
		TrustedHostKeysBase64: payload.TrustedHostKeysBase64,
		Jump:                  sshconn.JumpTargetFromCore(payload.Jump),
		WSProxy:               payload.WSProxy,
	}
	// 홉 진행을 renderer로 방출(EndpointID로 SFTP pane에 매핑) — 세션·컨테이너·probe와 동일한 공통 헬퍼.
	config := sshconn.DefaultConfig
	config.Progress = sshconn.HopProgress(target, "", endpointID, s.emit)
	config.AuthAgentEndpointKind = payload.AuthAgentEndpointKind
	config.AuthAgentEndpoint = payload.AuthAgentEndpoint
	dial, dialErr := s.tailnetDialer(payload.TailnetID, payload.TailnetName)
	if dialErr != nil {
		return dialErr
	}
	config.Dial = dial
	// 처음 보는 서버 키는 이 연결 안에서 묻는다(별도 프로브 연결 없음 → OTP 한 번).
	config.HostKeyTrust = s.hostKeyTrust(ctx, hostkeytrust.Correlation{
		RequestID:  requestID,
		EndpointID: endpointID,
	})
	client, err := sshconn.DialClient(ctx, target, config, func(challenge sshconn.InteractiveChallenge) ([]string, error) {
		attempt += 1
		challengeID := fmt.Sprintf("%s-%d", endpointID, attempt)
		responseCh := make(chan []string, 1)

		s.mu.Lock()
		s.pendingChallenges[challengeID] = &pendingChallenge{
			endpointID: endpointID,
			responses:  responseCh,
		}
		s.mu.Unlock()
		defer func() {
			s.mu.Lock()
			delete(s.pendingChallenges, challengeID)
			s.mu.Unlock()
		}()

		prompts := make([]protocol.KeyboardInteractivePrompt, 0, len(challenge.Prompts))
		for _, prompt := range challenge.Prompts {
			prompts = append(prompts, protocol.KeyboardInteractivePrompt{
				Label: prompt.Label,
				Echo:  prompt.Echo,
				// 판정은 sshconn 이 홉마다 내린다 — 화면은 그대로 그린다.
				AllowStoredPassword: prompt.AllowStoredPassword,
				Masked:              prompt.Masked,
			})
		}

		s.emit(protocol.Event{
			Type:       protocol.EventKeyboardInteractiveChallenge,
			RequestID:  requestID,
			EndpointID: endpointID,
			Payload: protocol.KeyboardInteractiveChallengePayload{
				ChallengeID: challengeID,
				// 어느 홉이 묻는지. 점프 체인에서 이것이 없으면 사용자가 누구의 코드인지 모른다.
				Hop:         sshconn.HopPayload(challenge.Hop),
				Attempt:     attempt,
				Name:        challenge.Name,
				Instruction: challenge.Instruction,
				Prompts:     prompts,
			},
		})

		// 답을 기다린다. 취소(정지·종료)와 **예산**이 함께 걸려 있다.
		//
		// ctx 취소는 conn 을 닫아 핸드셰이크를 풀지만 이 채널 대기는 그것과 무관하게 서 있다.
		// 예산이 없으면 아무도 답하지 않는 프롬프트가 이 연결을 영원히 붙잡는다 — tailnet 을 경유하면
		// 그 노드의 리스까지 잡은 채라서, 설정의 "연결 종료" 가 계속 거절된다(sshconn.HumanAnswerBudget).
		responses, waitErr := sshconn.WaitForHumanAnswer(ctx, responseCh)
		if waitErr != nil {
			return nil, fmt.Errorf("keyboard-interactive challenge was cancelled: %w", waitErr)
		}

		s.emit(protocol.Event{
			Type:       protocol.EventKeyboardInteractiveResolved,
			RequestID:  requestID,
			EndpointID: endpointID,
			Payload: map[string]any{
				"challengeId": challengeID,
			},
		})
		return responses, nil
	})
	if err != nil {
		return err
	}

	sftpClient, err := sftppkg.NewClient(
		client,
		sftppkg.UseConcurrentReads(true),
		sftppkg.UseConcurrentWrites(true),
		sftppkg.MaxConcurrentRequestsPerFile(transferConcurrentRequestsPerFile),
	)
	if err != nil {
		_ = client.Close()
		return fmt.Errorf("sftp client creation failed: %w", err)
	}

	rootPath := "/"
	if resolvedPath, resolveErr := sftpClient.RealPath("."); resolveErr == nil && resolvedPath != "" {
		rootPath = resolvedPath
	}

	handle := &endpointHandle{
		client:     client,
		sftp:       sftpClient,
		rootPath:   rootPath,
		sudoStatus: "probing",
	}

	s.mu.Lock()
	s.endpoints[endpointID] = handle
	s.mu.Unlock()

	s.emit(protocol.Event{
		Type:       protocol.EventSFTPConnected,
		RequestID:  requestID,
		EndpointID: endpointID,
		Payload: protocol.SFTPConnectedPayload{
			Path:       rootPath,
			SudoStatus: "probing",
		},
	})

	go s.probeSudo(endpointID, payload.AuthType, payload.Password)

	return nil
}

// CancelInFlight 는 아직 붙는 중인 연결을 끊는다(forwarding 과 같은 이유).
func (s *Service) CancelInFlight(endpointID string) {
	s.starting.Cancel(endpointID)
}

func (s *Service) Disconnect(endpointID, requestID string) error {
	// 아직 붙는 중이면 그 작업부터 끊는다.
	s.starting.Cancel(endpointID)
	handle, ok := s.removeEndpoint(endpointID)
	if ok {
		handle.close()
	}
	for _, challenge := range s.removePendingChallengesForEndpoint(endpointID) {
		close(challenge.responses)
	}

	s.emit(protocol.Event{
		Type:       protocol.EventSFTPDisconnected,
		RequestID:  requestID,
		EndpointID: endpointID,
		Payload: protocol.AckPayload{
			Message: "sftp endpoint disconnected",
		},
	})

	return nil
}

func (s *Service) RespondKeyboardInteractive(endpointID, challengeID string, responses []string) error {
	s.mu.Lock()
	challenge, ok := s.pendingChallenges[challengeID]
	s.mu.Unlock()
	if !ok {
		return fmt.Errorf("keyboard-interactive challenge %s not found for endpoint %s", challengeID, endpointID)
	}
	if challenge.endpointID != endpointID {
		return fmt.Errorf("keyboard-interactive challenge %s does not belong to endpoint %s", challengeID, endpointID)
	}

	select {
	case challenge.responses <- responses:
		return nil
	default:
		return fmt.Errorf("keyboard-interactive challenge %s already has a pending response", challengeID)
	}
}

func (s *Service) List(endpointID, requestID string, payload protocol.SFTPListPayload) error {
	handle, err := s.getEndpoint(endpointID)
	if err != nil {
		return err
	}

	targetPath := payload.Path
	if targetPath == "" {
		targetPath = handle.rootPath
	}
	if resolvedPath, resolveErr := handle.sftp.RealPath(targetPath); resolveErr == nil && resolvedPath != "" {
		targetPath = resolvedPath
	}

	items, err := handle.sftp.ReadDir(targetPath)
	if err != nil {
		return err
	}

	ownerNames, groupNames := s.resolveEntryPrincipalNames(handle, items)
	entries := make([]protocol.SFTPFileEntry, 0, len(items))
	for _, item := range items {
		entries = append(entries, toFileEntry(targetPath, item, ownerNames, groupNames))
	}

	sort.Slice(entries, func(i, j int) bool {
		if entries[i].IsDirectory != entries[j].IsDirectory {
			return entries[i].IsDirectory
		}
		return entries[i].Name < entries[j].Name
	})

	s.emit(protocol.Event{
		Type:       protocol.EventSFTPListed,
		RequestID:  requestID,
		EndpointID: endpointID,
		Payload: protocol.SFTPListedPayload{
			Path:    targetPath,
			Entries: entries,
		},
	})

	return nil
}

func (s *Service) Mkdir(endpointID, requestID string, payload protocol.SFTPMkdirPayload) error {
	handle, err := s.getEndpoint(endpointID)
	if err != nil {
		return err
	}

	targetPath := path.Join(payload.Path, payload.Name)
	if err := handle.sftp.Mkdir(targetPath); err != nil {
		return err
	}

	s.emit(protocol.Event{
		Type:       protocol.EventSFTPAck,
		RequestID:  requestID,
		EndpointID: endpointID,
		Payload: protocol.AckPayload{
			Message: "directory created",
		},
	})
	return nil
}

func (s *Service) Rename(endpointID, requestID string, payload protocol.SFTPRenamePayload) error {
	handle, err := s.getEndpoint(endpointID)
	if err != nil {
		return err
	}

	nextPath := path.Join(path.Dir(payload.Path), payload.NextName)
	if err := handle.sftp.Rename(payload.Path, nextPath); err != nil {
		return err
	}

	s.emit(protocol.Event{
		Type:       protocol.EventSFTPAck,
		RequestID:  requestID,
		EndpointID: endpointID,
		Payload: protocol.AckPayload{
			Message: "path renamed",
		},
	})
	return nil
}

func (s *Service) Chmod(endpointID, requestID string, payload protocol.SFTPChmodPayload) error {
	handle, err := s.getEndpoint(endpointID)
	if err != nil {
		return err
	}

	if err := handle.sftp.Chmod(payload.Path, os.FileMode(payload.Mode)); err != nil {
		return err
	}

	s.emit(protocol.Event{
		Type:       protocol.EventSFTPAck,
		RequestID:  requestID,
		EndpointID: endpointID,
		Payload: protocol.AckPayload{
			Message: "path permissions updated",
		},
	})
	return nil
}

func (s *Service) Chown(endpointID, requestID string, payload protocol.SFTPChownPayload) error {
	handle, err := s.getEndpoint(endpointID)
	if err != nil {
		return err
	}

	spec, err := buildChownOwnerSpec(payload)
	if err != nil {
		return err
	}
	if strings.TrimSpace(payload.Path) == "" {
		return fmt.Errorf("path is required")
	}

	stdin := []byte(nil)
	command := ""
	status := s.getSudoStatus(endpointID)
	switch status {
	case "root":
		command = buildChownCommand("", spec, payload.Path, payload.Recursive)
	case "passwordless":
		password := strings.TrimRight(payload.SudoPassword, "\r\n")
		if password == "" {
			password = handle.sudoPassword
		}
		if password != "" {
			command = buildChownCommand("sudo -S -p ''", spec, payload.Path, payload.Recursive)
			stdin = []byte(password + "\n")
		} else {
			command = buildChownCommand("sudo -n", spec, payload.Path, payload.Recursive)
		}
	default:
		password := strings.TrimRight(payload.SudoPassword, "\r\n")
		if password == "" {
			password = handle.sudoPassword
		}
		if password == "" {
			return fmt.Errorf("sudo password is required")
		}
		command = buildChownCommand("sudo -S -p ''", spec, payload.Path, payload.Recursive)
		stdin = []byte(password + "\n")
	}

	if _, stderr, err := sshcmd.RunWithInputWithTimeout(handle.client, command, stdin, 20*time.Second); err != nil {
		return formatRemoteCommandError(err, stderr)
	}

	if payload.SudoPassword != "" {
		s.setSudoStatus(endpointID, "passwordless", "sudo password accepted", strings.TrimRight(payload.SudoPassword, "\r\n"))
	}

	s.emit(protocol.Event{
		Type:       protocol.EventSFTPAck,
		RequestID:  requestID,
		EndpointID: endpointID,
		Payload: protocol.AckPayload{
			Message: "path owner updated",
		},
	})
	return nil
}

func (s *Service) ListPrincipals(endpointID, requestID string, payload protocol.SFTPListPrincipalsPayload) error {
	handle, err := s.getEndpoint(endpointID)
	if err != nil {
		return err
	}
	kind := normalizePrincipalKind(payload.Kind)
	if kind == "" {
		return fmt.Errorf("principal kind must be user or group")
	}
	limit := payload.Limit
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	principals, err := listRemotePrincipals(handle.client, kind, payload.Query, limit)
	if err != nil {
		return err
	}

	s.emit(protocol.Event{
		Type:       protocol.EventSFTPPrincipalsListed,
		RequestID:  requestID,
		EndpointID: endpointID,
		Payload: protocol.SFTPPrincipalsListedPayload{
			Kind:       kind,
			Query:      payload.Query,
			Principals: principals,
		},
	})
	return nil
}

func (s *Service) Delete(endpointID, requestID string, payload protocol.SFTPDeletePayload) error {
	handle, err := s.getEndpoint(endpointID)
	if err != nil {
		return err
	}

	for _, targetPath := range payload.Paths {
		if err := removeRemotePath(handle.sftp, targetPath); err != nil {
			return err
		}
	}

	s.emit(protocol.Event{
		Type:       protocol.EventSFTPAck,
		RequestID:  requestID,
		EndpointID: endpointID,
		Payload: protocol.AckPayload{
			Message: "paths deleted",
		},
	})
	return nil
}

// 편집기 규칙은 sftpedit 한 곳에 있다 — 모바일 바인드도 같은 함수를 호출한다.
const sudoRequiredPrefix = "sftp-sudo-required:"

// ReadFile loads a small text file into memory for the built-in editor. It
// rejects directories, oversized files, and binary content so the renderer
// never tries to edit something unsuitable.
func (s *Service) ReadFile(endpointID, requestID string, payload protocol.SFTPReadFilePayload) error {
	handle, err := s.getEndpoint(endpointID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(payload.Path) == "" {
		return fmt.Errorf("path is required")
	}

	loaded, err := sftpedit.ReadTextFile(handle.sftp, payload.Path)
	if err != nil {
		return err
	}

	s.emit(protocol.Event{
		Type:       protocol.EventSFTPFileRead,
		RequestID:  requestID,
		EndpointID: endpointID,
		Payload: protocol.SFTPFileReadPayload{
			Path:    payload.Path,
			Content: loaded.Content,
			Size:    loaded.Size,
			Mtime:   loaded.Mtime,
			Mode:    loaded.Mode,
		},
	})
	return nil
}

// WriteFile saves editor content back to the remote file. It detects whether
// the remote changed since it was read (conflict), then writes atomically
// (temp + rename) when the directory is writable, falling back to a privileged
// sudo write (mirrors Chown) for root-owned locations.
func (s *Service) WriteFile(endpointID, requestID string, payload protocol.SFTPWriteFilePayload) error {
	handle, err := s.getEndpoint(endpointID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(payload.Path) == "" {
		return fmt.Errorf("path is required")
	}

	content := []byte(payload.Content)
	info, statErr := handle.sftp.Stat(payload.Path)

	if err := sftpedit.CheckConflict(info, statErr, sftpedit.ConflictCheck{
		ExpectedSize:  payload.ExpectedSize,
		ExpectedMtime: payload.ExpectedMtime,
		Force:         payload.Force,
	}); err != nil {
		return err
	}

	mode := sftpedit.ResolveMode(payload.Mode, info, statErr)

	// Without an explicit sudo password, try a direct unprivileged atomic write.
	if strings.TrimSpace(payload.SudoPassword) == "" {
		writeErr := sftpedit.AtomicWrite(handle.sftp, payload.Path, content, mode, payload.PreserveMtime, info, statErr)
		if writeErr == nil {
			s.emit(protocol.Event{
				Type:       protocol.EventSFTPAck,
				RequestID:  requestID,
				EndpointID: endpointID,
				Payload:    protocol.AckPayload{Message: "file saved"},
			})
			return nil
		}
		if classifyTransferError(writeErr) != transferErrorPermissionDenied {
			return writeErr
		}
		// Permission denied: only escalate automatically when sudo is usable.
		status := s.getSudoStatus(endpointID)
		if status != "root" && status != "passwordless" && handle.sudoPassword == "" {
			return fmt.Errorf("%s sudo password is required to write %s", sudoRequiredPrefix, payload.Path)
		}
	}

	if err := s.sudoRemoteWrite(endpointID, handle, payload.Path, content, mode, payload.SudoPassword); err != nil {
		return err
	}
	if strings.TrimSpace(payload.SudoPassword) != "" {
		s.setSudoStatus(endpointID, "passwordless", "sudo password accepted", strings.TrimRight(payload.SudoPassword, "\r\n"))
	}
	s.emit(protocol.Event{
		Type:       protocol.EventSFTPAck,
		RequestID:  requestID,
		EndpointID: endpointID,
		Payload:    protocol.AckPayload{Message: "file saved"},
	})
	return nil
}

// atomicRemoteWrite writes content to a sibling temp file then renames it over
// the target, so an interrupted write never truncates the original. It needs
// only directory write permission.

// sudoRemoteWrite stages content in a user-writable temp via SFTP (no
// privilege), then installs it into place with sudo. The sudo password travels
// only on the command stdin, never in the command string (mirrors Chown).
func (s *Service) sudoRemoteWrite(
	endpointID string,
	handle *endpointHandle,
	targetPath string,
	content []byte,
	mode os.FileMode,
	sudoPassword string,
) error {
	stagePath := fmt.Sprintf("/tmp/.dolgate-edit-%d.tmp", time.Now().UnixNano())
	stage, err := handle.sftp.Create(stagePath)
	if err != nil {
		return fmt.Errorf("failed to stage file for privileged save: %w", err)
	}
	if _, err := stage.Write(content); err != nil {
		_ = stage.Close()
		_ = handle.sftp.Remove(stagePath)
		return err
	}
	if err := stage.Close(); err != nil {
		_ = handle.sftp.Remove(stagePath)
		return err
	}
	defer func() { _ = handle.sftp.Remove(stagePath) }()

	prefix, stdin := s.sudoInvocation(endpointID, handle, sudoPassword)
	command := buildSudoInstallCommand(prefix, fmt.Sprintf("%04o", mode.Perm()), stagePath, targetPath)
	if _, stderr, err := sshcmd.RunWithInputWithTimeout(handle.client, command, stdin, 30*time.Second); err != nil {
		return formatRemoteCommandError(err, stderr)
	}
	return nil
}

func (s *Service) sudoInvocation(endpointID string, handle *endpointHandle, sudoPassword string) (string, []byte) {
	if s.getSudoStatus(endpointID) == "root" {
		return "", nil
	}
	password := strings.TrimRight(sudoPassword, "\r\n")
	if password == "" {
		password = handle.sudoPassword
	}
	if password != "" {
		return "sudo -S -p ''", []byte(password + "\n")
	}
	return "sudo -n", nil
}

func buildSudoInstallCommand(prefix, mode, stagePath, targetPath string) string {
	parts := []string{}
	if strings.TrimSpace(prefix) != "" {
		parts = append(parts, prefix)
	}
	parts = append(parts, "install", "-m", mode, "--", sshcmd.QuotePosix(stagePath), sshcmd.QuotePosix(targetPath))
	return strings.Join(parts, " ")
}

func (s *Service) StartTransfer(jobID string, payload protocol.SFTPTransferStartPayload) error {
	ctx, cancel := context.WithCancel(context.Background())
	progress := newTransferProgress(time.Now())
	pauseController := newTransferPauseController()
	reporter := newTransferProgressReporter(
		jobID,
		progress,
		s.emitTransferEvent,
		time.Now,
	)
	cleanupTracker := newTransferCleanupTracker(func(targetPath string) {
		targetFS, err := s.resolveAccessor(payload.Target)
		if err != nil {
			return
		}
		_ = targetFS.Remove(targetPath)
	})

	s.mu.Lock()
	s.transfers[jobID] = &transferHandle{
		cancel:          cancel,
		pauseController: pauseController,
		progress:        progress,
		reporter:        reporter,
		cleanup:         cleanupTracker,
	}
	s.mu.Unlock()

	go s.runTransfer(ctx, jobID, payload, pauseController, progress, reporter, cleanupTracker)
	return nil
}

func (s *Service) CancelTransfer(jobID string) error {
	s.mu.RLock()
	handle, ok := s.transfers[jobID]
	s.mu.RUnlock()
	if ok {
		handle.cancel()
	}
	return nil
}

func (s *Service) PauseTransfer(jobID string) error {
	s.mu.RLock()
	handle, ok := s.transfers[jobID]
	s.mu.RUnlock()
	if !ok {
		return nil
	}
	handle.pauseController.Pause()
	handle.reporter.emitPaused("", "transfer paused")
	return nil
}

func (s *Service) ResumeTransfer(jobID string) error {
	s.mu.RLock()
	handle, ok := s.transfers[jobID]
	s.mu.RUnlock()
	if !ok {
		return nil
	}
	handle.pauseController.Resume()
	handle.reporter.emitRunning("", "transfer resumed", true)
	return nil
}

func (s *Service) runTransfer(
	ctx context.Context,
	jobID string,
	payload protocol.SFTPTransferStartPayload,
	pauseController *transferPauseController,
	progress *transferProgress,
	reporter *transferProgressReporter,
	cleanupTracker *transferCleanupTracker,
) {
	defer s.removeTransfer(jobID)
	defer cleanupTracker.CleanupAll()

	sourceFS, err := s.resolveAccessor(payload.Source)
	if err != nil {
		s.emitTransferFailed(jobID, err)
		return
	}

	targetFS, err := s.resolveAccessor(payload.Target)
	if err != nil {
		s.emitTransferFailed(jobID, err)
		return
	}

	metadataOptions := resolveTransferMetadataOptions(payload.PreserveMetadata)
	failedItems := make([]protocol.TransferFailedItemPayload, 0)
	completedItems := 0
	for _, item := range payload.Items {
		size, sizeErr := calculateTotalSize(ctx, sourceFS, item.Path)
		if sizeErr != nil {
			if errors.Is(sizeErr, context.Canceled) || errors.Is(sizeErr, context.DeadlineExceeded) {
				reporter.emitTerminal(
					protocol.EventSFTPTransferCancelled,
					"cancelled",
					item.Name,
					"",
				)
				return
			}
			failedItems = append(failedItems, toTransferFailedItem(item, annotateTransferItem(sizeErr, item.Name)))
			continue
		}
		progress.bytesTotal += size
	}

	reporter.emitRunning("", "", true)

	for _, item := range payload.Items {
		if containsFailedTransferItem(failedItems, item) {
			continue
		}
		if err := pauseController.Wait(ctx); err != nil {
			reporter.emitTerminal(
				protocol.EventSFTPTransferCancelled,
				"cancelled",
				item.Name,
				"",
			)
			return
		}
		reporter.emitRunning(item.Name, "", true)
		targetPath := targetFS.Join(payload.Target.Path, item.Name)
		if err := s.copyPath(
			ctx,
			sourceFS,
			targetFS,
			item.Path,
			targetPath,
			payload.ConflictResolution,
			jobID,
			pauseController,
			metadataOptions,
			cleanupTracker,
			reporter,
		); err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				reporter.emitTerminal(
					protocol.EventSFTPTransferCancelled,
					"cancelled",
					item.Name,
					"",
				)
				return
			}
			failedItems = append(failedItems, toTransferFailedItem(item, annotateTransferItem(err, item.Name)))
			continue
		}
		completedItems += 1
	}

	if len(failedItems) > 0 {
		cleanupTracker.CleanupAll()
		s.emitTransferFailedItems(jobID, failedItems, completedItems)
		return
	}
	reporter.emitTerminal(protocol.EventSFTPTransferCompleted, "completed", "", "")
}

func (s *Service) copyPath(
	ctx context.Context,
	sourceFS filesystemAccessor,
	targetFS filesystemAccessor,
	sourcePath string,
	targetPath string,
	conflictResolution string,
	jobID string,
	pauseController *transferPauseController,
	metadataOptions transferMetadataOptions,
	cleanupTracker *transferCleanupTracker,
	reporter *transferProgressReporter,
) error {
	if err := pauseController.Wait(ctx); err != nil {
		return err
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}

	sourceInfo, err := sourceFS.Stat(sourcePath)
	if err != nil {
		return annotateTransferError("source_stat", sourcePath, err)
	}

	nextTargetPath, skip, mergeIntoExistingDir, replaceExisting, err := prepareDestination(targetFS, sourceInfo, targetPath, conflictResolution)
	if err != nil {
		return err
	}
	if skip {
		return nil
	}

	if sourceInfo.IsDir() {
		if !mergeIntoExistingDir {
			if err := targetFS.MkdirAll(nextTargetPath); err != nil {
				return annotateTransferError("target_mkdir", nextTargetPath, err)
			}
		}
		entries, err := sourceFS.ReadDir(sourcePath)
		if err != nil {
			return annotateTransferError("source_list", sourcePath, err)
		}
		for _, entry := range entries {
			if err := s.copyPath(
				ctx,
				sourceFS,
				targetFS,
				sourceFS.Join(sourcePath, entry.Name()),
				targetFS.Join(nextTargetPath, entry.Name()),
				conflictResolution,
				jobID,
				pauseController,
				metadataOptions,
				cleanupTracker,
				reporter,
			); err != nil {
				return err
			}
		}
		_ = applyTransferMetadata(targetFS, nextTargetPath, sourceInfo, metadataOptions)
		return nil
	}

	reporter.emitRunning(sourceFS.Base(sourcePath), "", true)
	return copyFileWithProgress(
		ctx,
		sourceFS,
		targetFS,
		sourcePath,
		nextTargetPath,
		jobID,
		pauseController,
		metadataOptions,
		sourceInfo,
		replaceExisting,
		cleanupTracker,
		reporter,
	)
}

func (s *Service) emitTransferEvent(event protocol.Event) {
	s.emit(event)
}

func (s *Service) emitTransferFailed(jobID string, err error) {
	payload := protocol.SFTPTransferProgressPayload{
		Status:        "failed",
		Message:       err.Error(),
		DetailMessage: err.Error(),
		ErrorCode:     classifyTransferError(err),
	}
	var transferErr *transferError
	if errors.As(err, &transferErr) {
		payload.ErrorCode = transferErr.Code
		payload.ErrorOperation = transferErr.Operation
		payload.ErrorPath = transferErr.Path
		payload.ErrorItemName = transferErr.ItemName
		if transferErr.Detail != "" {
			payload.DetailMessage = transferErr.Detail
			payload.Message = transferErr.Detail
		}
	}
	s.emitTransferEvent(protocol.Event{
		Type:    protocol.EventSFTPTransferFailed,
		JobID:   jobID,
		Payload: payload,
	})
}

func (s *Service) emitTransferFailedItems(
	jobID string,
	failedItems []protocol.TransferFailedItemPayload,
	completedItems int,
) {
	message := fmt.Sprintf("%d transfer item(s) failed", len(failedItems))
	payload := protocol.SFTPTransferProgressPayload{
		Status:             "failed",
		Message:            message,
		DetailMessage:      message,
		ErrorCode:          transferErrorUnknown,
		CompletedItemCount: completedItems,
		FailedItemCount:    len(failedItems),
		FailedItems:        failedItems,
	}
	if len(failedItems) > 0 {
		first := failedItems[0]
		payload.Message = first.ErrorMessage
		payload.DetailMessage = first.ErrorMessage
		payload.ErrorCode = first.ErrorCode
		payload.ErrorOperation = first.ErrorOperation
		payload.ErrorPath = first.ErrorPath
		payload.ErrorItemName = first.Item.Name
	}
	s.emitTransferEvent(protocol.Event{
		Type:    protocol.EventSFTPTransferFailed,
		JobID:   jobID,
		Payload: payload,
	})
}

func resolveTransferMetadataOptions(payload protocol.TransferMetadataPayload) transferMetadataOptions {
	options := transferMetadataOptions{
		preserveMtime:       true,
		preservePermissions: false,
	}
	if payload.Mtime != nil {
		options.preserveMtime = *payload.Mtime
	}
	if payload.Permissions != nil {
		options.preservePermissions = *payload.Permissions
	}
	return options
}

func toTransferFailedItem(item protocol.TransferItemPayload, err error) protocol.TransferFailedItemPayload {
	failed := protocol.TransferFailedItemPayload{
		Item:         item,
		ErrorMessage: err.Error(),
		ErrorCode:    classifyTransferError(err),
	}
	var transferErr *transferError
	if errors.As(err, &transferErr) {
		failed.ErrorCode = transferErr.Code
		failed.ErrorOperation = transferErr.Operation
		failed.ErrorPath = transferErr.Path
		if transferErr.Detail != "" {
			failed.ErrorMessage = transferErr.Detail
		}
	}
	return failed
}

func containsFailedTransferItem(items []protocol.TransferFailedItemPayload, item protocol.TransferItemPayload) bool {
	for _, failed := range items {
		if failed.Item.Path == item.Path && failed.Item.Name == item.Name {
			return true
		}
	}
	return false
}

func (s *Service) resolveAccessor(endpoint protocol.TransferEndpointPayload) (filesystemAccessor, error) {
	switch endpoint.Kind {
	case "local":
		return localFilesystemAccessor{}, nil
	case "remote":
		handle, err := s.getEndpoint(endpoint.EndpointID)
		if err != nil {
			return nil, err
		}
		return remoteFilesystemAccessor{client: handle.sftp}, nil
	default:
		return nil, fmt.Errorf("unsupported transfer endpoint kind: %s", endpoint.Kind)
	}
}

func (s *Service) getEndpoint(endpointID string) (*endpointHandle, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	handle, ok := s.endpoints[endpointID]
	if !ok {
		return nil, fmt.Errorf("endpoint %s not found", endpointID)
	}
	return handle, nil
}

func (s *Service) removeEndpoint(endpointID string) (*endpointHandle, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	handle, ok := s.endpoints[endpointID]
	if ok {
		delete(s.endpoints, endpointID)
	}
	return handle, ok
}

func (s *Service) removePendingChallengesForEndpoint(endpointID string) []*pendingChallenge {
	s.mu.Lock()
	defer s.mu.Unlock()

	challenges := make([]*pendingChallenge, 0)
	for challengeID, challenge := range s.pendingChallenges {
		if challenge.endpointID != endpointID {
			continue
		}
		challenges = append(challenges, challenge)
		delete(s.pendingChallenges, challengeID)
	}
	return challenges
}

func (s *Service) removeTransfer(jobID string) {
	s.mu.Lock()
	delete(s.transfers, jobID)
	s.mu.Unlock()
}

func (handle *endpointHandle) close() {
	handle.closer.Do(func() {
		_ = handle.sftp.Close()
		_ = handle.client.Close()
	})
}

func toFileEntry(
	parentPath string,
	item os.FileInfo,
	ownerNames map[int]string,
	groupNames map[int]string,
) protocol.SFTPFileEntry {
	kind := "unknown"
	switch {
	case item.IsDir():
		kind = "folder"
	case item.Mode()&os.ModeSymlink != 0:
		kind = "symlink"
	case item.Mode().IsRegular():
		kind = "file"
	}

	uid, gid := fileInfoIDs(item)
	var uidPtr *int
	var gidPtr *int
	if uid != nil {
		value := *uid
		uidPtr = &value
	}
	if gid != nil {
		value := *gid
		gidPtr = &value
	}

	owner := ""
	if uid != nil {
		owner = ownerNames[*uid]
	}
	group := ""
	if gid != nil {
		group = groupNames[*gid]
	}

	return protocol.SFTPFileEntry{
		Name:        item.Name(),
		Path:        path.Join(parentPath, item.Name()),
		IsDirectory: item.IsDir(),
		Size:        item.Size(),
		Mtime:       item.ModTime().UTC().Format(time.RFC3339),
		Kind:        kind,
		Permissions: item.Mode().String(),
		UID:         uidPtr,
		GID:         gidPtr,
		Owner:       owner,
		Group:       group,
	}
}

func fileInfoIDs(item os.FileInfo) (*int, *int) {
	stat, ok := item.Sys().(*sftppkg.FileStat)
	if !ok || stat == nil {
		return nil, nil
	}
	uid := int(stat.UID)
	gid := int(stat.GID)
	return &uid, &gid
}

func (s *Service) resolveEntryPrincipalNames(
	handle *endpointHandle,
	items []os.FileInfo,
) (map[int]string, map[int]string) {
	userIDs := make(map[int]struct{})
	groupIDs := make(map[int]struct{})
	for _, item := range items {
		uid, gid := fileInfoIDs(item)
		if uid != nil {
			userIDs[*uid] = struct{}{}
		}
		if gid != nil {
			groupIDs[*gid] = struct{}{}
		}
	}
	return resolveRemotePrincipalNames(handle.client, "user", userIDs),
		resolveRemotePrincipalNames(handle.client, "group", groupIDs)
}

func resolveRemotePrincipalNames(
	client *ssh.Client,
	kind string,
	ids map[int]struct{},
) map[int]string {
	result := make(map[int]string)
	if len(ids) == 0 {
		return result
	}
	idValues := make([]int, 0, len(ids))
	for id := range ids {
		idValues = append(idValues, id)
	}
	sort.Ints(idValues)
	parts := make([]string, 0, len(idValues))
	for _, id := range idValues {
		parts = append(parts, strconv.Itoa(id))
	}

	stdout, _, err := sshcmd.RunWithTimeout(
		client,
		buildPrincipalLookupCommand(kind, parts),
		10*time.Second,
	)
	if err != nil {
		return result
	}
	for _, line := range strings.Split(string(stdout), "\n") {
		principal, ok := parsePrincipalLine(kind, line)
		if !ok {
			continue
		}
		result[principal.ID] = principal.Name
	}
	return result
}

func (s *Service) probeSudo(endpointID, authType, loginPassword string) {
	handle, err := s.getEndpoint(endpointID)
	if err != nil {
		return
	}

	stdout, stderr, err := sshcmd.RunWithTimeout(handle.client, "id -u", 10*time.Second)
	if err != nil {
		s.setSudoStatus(endpointID, "unavailable", formatRemoteCommandError(err, stderr).Error(), "")
		return
	}
	if strings.TrimSpace(string(stdout)) == "0" {
		s.setSudoStatus(endpointID, "root", "connected user is root", "")
		return
	}

	if _, stderr, err := sshcmd.RunWithTimeout(handle.client, "sudo -n -v", 10*time.Second); err == nil {
		s.setSudoStatus(endpointID, "passwordless", "passwordless sudo is available", "")
		return
	} else if classifySudoFailure(stderr) == "unavailable" {
		s.setSudoStatus(endpointID, "unavailable", strings.TrimSpace(string(stderr)), "")
		return
	}

	if authType == "password" && loginPassword != "" {
		if _, stderr, err := sshcmd.RunWithInputWithTimeout(
			handle.client,
			"sudo -S -p '' -v",
			[]byte(loginPassword+"\n"),
			10*time.Second,
		); err == nil {
			s.setSudoStatus(endpointID, "passwordless", "login password accepted for sudo", loginPassword)
			return
		} else if classifySudoFailure(stderr) == "unavailable" {
			s.setSudoStatus(endpointID, "unavailable", strings.TrimSpace(string(stderr)), "")
			return
		}
	}

	s.setSudoStatus(endpointID, "passwordRequired", "sudo password is required", "")
}

func (s *Service) getSudoStatus(endpointID string) string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	handle, ok := s.endpoints[endpointID]
	if !ok || handle.sudoStatus == "" {
		return "unknown"
	}
	return handle.sudoStatus
}

func (s *Service) setSudoStatus(endpointID, status, message, sudoPassword string) {
	s.mu.Lock()
	handle, ok := s.endpoints[endpointID]
	if ok {
		handle.sudoStatus = status
		if sudoPassword != "" {
			handle.sudoPassword = sudoPassword
		}
	}
	s.mu.Unlock()
	if !ok {
		return
	}
	s.emit(protocol.Event{
		Type:       protocol.EventSFTPSudoStatus,
		EndpointID: endpointID,
		Payload: protocol.SFTPSudoStatusPayload{
			Status:  status,
			Message: message,
		},
	})
}

func classifySudoFailure(stderr []byte) string {
	text := strings.ToLower(strings.TrimSpace(string(stderr)))
	switch {
	case strings.Contains(text, "not in the sudoers"),
		strings.Contains(text, "may not run sudo"),
		strings.Contains(text, "a terminal is required"),
		strings.Contains(text, "must have a tty"):
		return "unavailable"
	case strings.Contains(text, "password"),
		strings.Contains(text, "try again"):
		return "passwordRequired"
	default:
		return "passwordRequired"
	}
}

func buildChownOwnerSpec(payload protocol.SFTPChownPayload) (string, error) {
	owner := strings.TrimSpace(payload.Owner)
	group := strings.TrimSpace(payload.Group)
	if payload.UID != nil {
		if *payload.UID < 0 {
			return "", fmt.Errorf("uid must be greater than or equal to 0")
		}
		owner = strconv.Itoa(*payload.UID)
	}
	if payload.GID != nil {
		if *payload.GID < 0 {
			return "", fmt.Errorf("gid must be greater than or equal to 0")
		}
		group = strconv.Itoa(*payload.GID)
	}
	if strings.Contains(owner, ":") || strings.Contains(group, ":") {
		return "", fmt.Errorf("owner and group must not contain ':'")
	}
	switch {
	case owner != "" && group != "":
		return owner + ":" + group, nil
	case owner != "":
		return owner, nil
	case group != "":
		return ":" + group, nil
	default:
		return "", fmt.Errorf("owner or group is required")
	}
}

func buildChownCommand(prefix, ownerSpec, targetPath string, recursive bool) string {
	parts := []string{}
	if strings.TrimSpace(prefix) != "" {
		parts = append(parts, prefix)
	}
	parts = append(parts, "chown")
	if recursive {
		parts = append(parts, "-R")
	}
	parts = append(parts, "--", sshcmd.QuotePosix(ownerSpec), sshcmd.QuotePosix(targetPath))
	return strings.Join(parts, " ")
}

func formatRemoteCommandError(err error, stderr []byte) error {
	detail := strings.TrimSpace(string(stderr))
	if detail == "" {
		return err
	}
	return fmt.Errorf("%w: %s", err, detail)
}

func normalizePrincipalKind(kind string) string {
	switch strings.TrimSpace(strings.ToLower(kind)) {
	case "user":
		return "user"
	case "group":
		return "group"
	default:
		return ""
	}
}

func listRemotePrincipals(
	client *ssh.Client,
	kind string,
	query string,
	limit int,
) ([]protocol.SFTPPrincipal, error) {
	stdout, stderr, err := sshcmd.RunWithTimeout(
		client,
		buildPrincipalListCommand(kind, query, limit),
		10*time.Second,
	)
	if err != nil {
		return nil, formatRemoteCommandError(err, stderr)
	}
	principals := make([]protocol.SFTPPrincipal, 0)
	seen := make(map[int]struct{})
	for _, line := range strings.Split(string(stdout), "\n") {
		principal, ok := parsePrincipalLine(kind, line)
		if !ok {
			continue
		}
		if _, exists := seen[principal.ID]; exists {
			continue
		}
		seen[principal.ID] = struct{}{}
		principals = append(principals, principal)
		if len(principals) >= limit {
			break
		}
	}
	return principals, nil
}

func buildPrincipalListCommand(kind string, query string, limit int) string {
	database := "passwd"
	fallbackFile := "/etc/passwd"
	if kind == "group" {
		database = "group"
		fallbackFile = "/etc/group"
	}
	script := fmt.Sprintf(
		`q=%s; limit=%s; if command -v getent >/dev/null 2>&1; then getent %s; elif [ -r %s ]; then cat %s; else exit 127; fi | awk -F: -v q="$q" -v limit="$limit" 'BEGIN { q=tolower(q); count=0 } { hay=tolower($1 " " $3 " " $5); if (q == "" || index(hay, q) > 0) { print; count++; if (count >= limit) exit } }'`,
		sshcmd.QuotePosix(query),
		sshcmd.QuotePosix(strconv.Itoa(limit)),
		database,
		sshcmd.QuotePosix(fallbackFile),
		sshcmd.QuotePosix(fallbackFile),
	)
	return "sh -lc " + sshcmd.QuotePosix(script)
}

func buildPrincipalLookupCommand(kind string, ids []string) string {
	database := "passwd"
	fallbackFile := "/etc/passwd"
	if kind == "group" {
		database = "group"
		fallbackFile = "/etc/group"
	}
	idText := strings.Join(ids, " ")
	script := fmt.Sprintf(
		`ids=%s; if command -v getent >/dev/null 2>&1; then for id in $ids; do getent %s "$id"; done; elif [ -r %s ]; then awk -F: -v ids=" $ids " 'index(ids, " " $3 " ") > 0 { print }' %s; fi`,
		sshcmd.QuotePosix(idText),
		database,
		sshcmd.QuotePosix(fallbackFile),
		sshcmd.QuotePosix(fallbackFile),
	)
	return "sh -lc " + sshcmd.QuotePosix(script)
}

func parsePrincipalLine(kind string, line string) (protocol.SFTPPrincipal, bool) {
	parts := strings.Split(strings.TrimSpace(line), ":")
	if len(parts) < 3 || parts[0] == "" {
		return protocol.SFTPPrincipal{}, false
	}
	id, err := strconv.Atoi(parts[2])
	if err != nil || id < 0 {
		return protocol.SFTPPrincipal{}, false
	}
	displayName := ""
	if kind == "user" && len(parts) >= 5 {
		displayName = strings.TrimSpace(strings.Split(parts[4], ",")[0])
	}
	return protocol.SFTPPrincipal{
		Kind:        kind,
		Name:        parts[0],
		ID:          id,
		DisplayName: displayName,
	}, true
}

func removeRemotePath(client *sftppkg.Client, targetPath string) error {
	info, err := client.Stat(targetPath)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return client.Remove(targetPath)
	}

	entries, err := client.ReadDir(targetPath)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if err := removeRemotePath(client, path.Join(targetPath, entry.Name())); err != nil {
			return err
		}
	}
	return client.RemoveDirectory(targetPath)
}
