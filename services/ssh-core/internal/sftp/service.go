package sftp

import (
	"context"
	"fmt"
	"io"
	"os"
	"path"
	"sort"
	"sync"
	"time"

	sftppkg "github.com/pkg/sftp"

	"dolssh/services/ssh-core/internal/protocol"
	"dolssh/services/ssh-core/internal/sshconn"
)

// EventEmitter는 SFTP 상태와 전송 이벤트를 상위 레이어로 올리는 함수다.
type EventEmitter func(protocol.Event)

type endpointHandle struct {
	client   io.Closer
	sftp     *sftppkg.Client
	rootPath string
	closer   sync.Once
}

type transferHandle struct {
	cancel context.CancelFunc
}

type Service struct {
	mu        sync.RWMutex
	endpoints map[string]*endpointHandle
	transfers map[string]*transferHandle
	emit      EventEmitter
}

func New(emit EventEmitter) *Service {
	return &Service{
		endpoints: make(map[string]*endpointHandle),
		transfers: make(map[string]*transferHandle),
		emit:      emit,
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
	s.mu.Unlock()

	for _, handle := range transfers {
		handle.cancel()
	}
	for _, handle := range endpoints {
		handle.close()
	}
}

func (s *Service) Connect(endpointID, requestID string, payload protocol.SFTPConnectPayload) error {
	client, err := sshconn.DialClient(sshconn.Target{
		Host:                 payload.Host,
		Port:                 payload.Port,
		Username:             payload.Username,
		AuthType:             payload.AuthType,
		Password:             payload.Password,
		PrivateKeyPEM:        payload.PrivateKeyPEM,
		PrivateKeyPath:       payload.PrivateKeyPath,
		Passphrase:           payload.Passphrase,
		TrustedHostKeyBase64: payload.TrustedHostKeyBase64,
	}, sshconn.DefaultConfig, nil)
	if err != nil {
		return err
	}

	sftpClient, err := sftppkg.NewClient(client)
	if err != nil {
		_ = client.Close()
		return fmt.Errorf("sftp client creation failed: %w", err)
	}

	rootPath := "/"
	if resolvedPath, resolveErr := sftpClient.RealPath("."); resolveErr == nil && resolvedPath != "" {
		rootPath = resolvedPath
	}

	handle := &endpointHandle{
		client:   client,
		sftp:     sftpClient,
		rootPath: rootPath,
	}

	s.mu.Lock()
	s.endpoints[endpointID] = handle
	s.mu.Unlock()

	s.emit(protocol.Event{
		Type:       protocol.EventSFTPConnected,
		RequestID:  requestID,
		EndpointID: endpointID,
		Payload: protocol.SFTPConnectedPayload{
			Path: rootPath,
		},
	})

	return nil
}

func (s *Service) Disconnect(endpointID, requestID string) error {
	handle, ok := s.removeEndpoint(endpointID)
	if ok {
		handle.close()
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

	entries := make([]protocol.SFTPFileEntry, 0, len(items))
	for _, item := range items {
		entries = append(entries, toFileEntry(targetPath, item))
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

	progress := &transferProgress{
		startedAt: time.Now(),
	}

	for _, item := range payload.Items {
		size, sizeErr := calculateTotalSize(ctx, sourceFS, item.Path)
		if sizeErr != nil {
			s.emitTransferFailed(jobID, sizeErr)
			return
		}
		progress.bytesTotal += size
	}

	s.emitTransferEvent(protocol.Event{
		Type:    protocol.EventSFTPTransferProgress,
		JobID:   jobID,
		Payload: progress.snapshot("running", "", ""),
	})

	for _, item := range payload.Items {
		progress.activeItemName = item.Name
		targetPath := targetFS.Join(payload.Target.Path, item.Name)
		if err := s.copyPath(ctx, jobID, progress, sourceFS, targetFS, item.Path, targetPath, payload.ConflictResolution); err != nil {
			if err == context.Canceled || err == context.DeadlineExceeded {
				s.emitTransferEvent(protocol.Event{
					Type:    protocol.EventSFTPTransferCancelled,
					JobID:   jobID,
					Payload: progress.snapshot("cancelled", item.Name, ""),
				})
				return
			}
			s.emitTransferFailed(jobID, err)
			return
		}
	}

	s.emitTransferEvent(protocol.Event{
		Type:    protocol.EventSFTPTransferCompleted,
		JobID:   jobID,
		Payload: progress.snapshot("completed", "", ""),
	})
}

func (s *Service) copyPath(
	ctx context.Context,
	jobID string,
	progress *transferProgress,
	sourceFS filesystemAccessor,
	targetFS filesystemAccessor,
	sourcePath string,
	targetPath string,
	conflictResolution string,
) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}

	sourceInfo, err := sourceFS.Stat(sourcePath)
	if err != nil {
		return err
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
				return err
			}
		}
		entries, err := sourceFS.ReadDir(sourcePath)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if err := s.copyPath(
				ctx,
				jobID,
				progress,
				sourceFS,
				targetFS,
				sourceFS.Join(sourcePath, entry.Name()),
				targetFS.Join(nextTargetPath, entry.Name()),
				conflictResolution,
			); err != nil {
				return err
			}
		}
		return nil
	}

	return copyFileWithProgress(ctx, jobID, progress, s.emitTransferEvent, sourceFS, targetFS, sourcePath, nextTargetPath)
}

func (s *Service) emitTransferEvent(event protocol.Event) {
	s.emit(event)
}

func (s *Service) emitTransferFailed(jobID string, err error) {
	s.emitTransferEvent(protocol.Event{
		Type:  protocol.EventSFTPTransferFailed,
		JobID: jobID,
		Payload: protocol.SFTPTransferProgressPayload{
			Status:  "failed",
			Message: err.Error(),
		},
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

func toFileEntry(parentPath string, item os.FileInfo) protocol.SFTPFileEntry {
	kind := "unknown"
	switch {
	case item.IsDir():
		kind = "folder"
	case item.Mode()&os.ModeSymlink != 0:
		kind = "symlink"
	case item.Mode().IsRegular():
		kind = "file"
	}

	return protocol.SFTPFileEntry{
		Name:        item.Name(),
		Path:        path.Join(parentPath, item.Name()),
		IsDirectory: item.IsDir(),
		Size:        item.Size(),
		Mtime:       item.ModTime().UTC().Format(time.RFC3339),
		Kind:        kind,
		Permissions: item.Mode().String(),
	}
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
