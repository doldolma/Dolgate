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

	"dolssh/services/ssh-core/internal/protocol"
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
	cancel context.CancelFunc
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
}

func New(emit EventEmitter) *Service {
	return &Service{
		endpoints:         make(map[string]*endpointHandle),
		transfers:         make(map[string]*transferHandle),
		pendingChallenges: make(map[string]*pendingChallenge),
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
	attempt := 0
	client, err := sshconn.DialClient(sshconn.Target{
		Host:                 payload.Host,
		Port:                 payload.Port,
		Username:             payload.Username,
		AuthType:             payload.AuthType,
		Password:             payload.Password,
		PrivateKeyPEM:        payload.PrivateKeyPEM,
		CertificateText:      payload.CertificateText,
		Passphrase:           payload.Passphrase,
		TrustedHostKeyBase64: payload.TrustedHostKeyBase64,
	}, sshconn.DefaultConfig, func(challenge sshconn.InteractiveChallenge) ([]string, error) {
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
			})
		}

		s.emit(protocol.Event{
			Type:       protocol.EventKeyboardInteractiveChallenge,
			RequestID:  requestID,
			EndpointID: endpointID,
			Payload: protocol.KeyboardInteractiveChallengePayload{
				ChallengeID: challengeID,
				Attempt:     attempt,
				Name:        challenge.Name,
				Instruction: challenge.Instruction,
				Prompts:     prompts,
			},
		})

		responses, ok := <-responseCh
		if !ok {
			return nil, fmt.Errorf("keyboard-interactive challenge was cancelled")
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

func (s *Service) Disconnect(endpointID, requestID string) error {
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

func (s *Service) StartTransfer(jobID string, payload protocol.SFTPTransferStartPayload) error {
	ctx, cancel := context.WithCancel(context.Background())

	s.mu.Lock()
	s.transfers[jobID] = &transferHandle{cancel: cancel}
	s.mu.Unlock()

	go s.runTransfer(ctx, jobID, payload)
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

func (s *Service) runTransfer(ctx context.Context, jobID string, payload protocol.SFTPTransferStartPayload) {
	defer s.removeTransfer(jobID)

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

	progress := newTransferProgress(time.Now())
	reporter := newTransferProgressReporter(
		jobID,
		progress,
		s.emitTransferEvent,
		time.Now,
	)

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
			s.emitTransferFailed(jobID, annotateTransferItem(sizeErr, item.Name))
			return
		}
		progress.bytesTotal += size
	}

	reporter.emitRunning("", "", true)

	for _, item := range payload.Items {
		reporter.emitRunning(item.Name, "", true)
		targetPath := targetFS.Join(payload.Target.Path, item.Name)
		if err := s.copyPath(
			ctx,
			sourceFS,
			targetFS,
			item.Path,
			targetPath,
			payload.ConflictResolution,
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
			s.emitTransferFailed(jobID, annotateTransferItem(err, item.Name))
			return
		}
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
	reporter *transferProgressReporter,
) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}

	sourceInfo, err := sourceFS.Stat(sourcePath)
	if err != nil {
		return annotateTransferError("source_stat", sourcePath, err)
	}

	nextTargetPath, skip, mergeIntoExistingDir, err := prepareDestination(targetFS, sourceInfo, targetPath, conflictResolution)
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
				reporter,
			); err != nil {
				return err
			}
		}
		return nil
	}

	reporter.emitRunning(sourceFS.Base(sourcePath), "", true)
	return copyFileWithProgress(
		ctx,
		sourceFS,
		targetFS,
		sourcePath,
		nextTargetPath,
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
