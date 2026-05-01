package http

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	sftppkg "github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"

	"dolssh/services/ssh-core/pkg/coretypes"
	coreruntime "dolssh/services/ssh-core/pkg/runtime"
)

const (
	awsSftpConnectTimeout = 10 * time.Second
	awsSftpTunnelTimeout  = 10 * time.Second
	awsSftpMaxChunkBytes  = 1024 * 1024
)

type awsSftpCoreRuntime interface {
	StartSSMPortForward(endpointID, requestID string, payload coretypes.SSMPortForwardStartPayload) error
	StopSSMPortForward(endpointID, requestID string) error
	Shutdown()
}

type AwsSftpBridge struct {
	runtime AwsSsmRuntime
	core    awsSftpCoreRuntime

	mu       sync.RWMutex
	sessions map[string]*awsSftpSession
	closing  bool
}

type awsSftpSession struct {
	id        string
	userID    string
	hostID    string
	tunnelID  string
	sshClient *ssh.Client
	sftp      *sftppkg.Client
	bridge    *AwsSftpBridge
	closed    sync.Once
}

type awsSftpCreateSessionRequest struct {
	HostID                string            `json:"hostId"`
	Label                 string            `json:"label"`
	ProfileName           string            `json:"profileName"`
	Region                string            `json:"region"`
	InstanceID            string            `json:"instanceId"`
	AvailabilityZone      string            `json:"availabilityZone"`
	SSHUsername           string            `json:"sshUsername"`
	SSHPort               int               `json:"sshPort"`
	Env                   map[string]string `json:"env"`
	UnsetEnv              []string          `json:"unsetEnv,omitempty"`
	TrustedHostKeyBase64  string            `json:"trustedHostKeyBase64,omitempty"`
	TrustedHostKeysBase64 []string          `json:"trustedHostKeysBase64,omitempty"`
}

type awsSftpSessionResponse struct {
	SessionID   string `json:"sessionId"`
	Path        string `json:"path"`
	ConnectedAt string `json:"connectedAt"`
}

type awsSftpHostKeyInfo struct {
	Host              string `json:"host"`
	Port              int    `json:"port"`
	RemoteIP          string `json:"remoteIp,omitempty"`
	Algorithm         string `json:"algorithm"`
	FingerprintSHA256 string `json:"fingerprintSha256"`
	KeyBase64         string `json:"keyBase64"`
}

type awsSftpHostKeyChallengeResponse struct {
	Code    string             `json:"code"`
	Message string             `json:"message"`
	Info    awsSftpHostKeyInfo `json:"info"`
}

type awsSftpHostKeyChallengeError struct {
	response awsSftpHostKeyChallengeResponse
}

func (err *awsSftpHostKeyChallengeError) Error() string {
	return err.response.Message
}

type awsSftpListResponse struct {
	Path    string             `json:"path"`
	Entries []awsSftpFileEntry `json:"entries"`
	Warning []string           `json:"warnings,omitempty"`
}

type awsSftpFileEntry struct {
	Name        string `json:"name"`
	Path        string `json:"path"`
	IsDirectory bool   `json:"isDirectory"`
	Size        int64  `json:"size"`
	Mtime       string `json:"mtime"`
	Kind        string `json:"kind"`
	Permissions string `json:"permissions,omitempty"`
}

type awsSftpPathRequest struct {
	Path string `json:"path"`
}

type awsSftpRenameRequest struct {
	SourcePath string `json:"sourcePath"`
	TargetPath string `json:"targetPath"`
}

type awsSftpChmodRequest struct {
	Path        string `json:"path"`
	Permissions uint32 `json:"permissions"`
}

type awsSftpReadRequest struct {
	Path   string `json:"path"`
	Offset int64  `json:"offset"`
	Length int    `json:"length"`
}

type awsSftpReadResponse struct {
	BytesBase64 string `json:"bytesBase64"`
	BytesRead   int    `json:"bytesRead"`
	EOF         bool   `json:"eof"`
}

type awsSftpWriteRequest struct {
	Path        string `json:"path"`
	Offset      int64  `json:"offset"`
	BytesBase64 string `json:"bytesBase64"`
}

func NewAwsSftpBridge(runtime AwsSsmRuntime) *AwsSftpBridge {
	bridge := &AwsSftpBridge{
		runtime:  runtime,
		sessions: make(map[string]*awsSftpSession),
	}
	bridge.core = coreruntime.New(coreruntime.Options{})
	return bridge
}

func newAwsSftpBridgeWithCore(runtime AwsSsmRuntime, core awsSftpCoreRuntime) *AwsSftpBridge {
	return &AwsSftpBridge{
		runtime:  runtime,
		core:     core,
		sessions: make(map[string]*awsSftpSession),
	}
}

func (bridge *AwsSftpBridge) Close() {
	bridge.mu.Lock()
	bridge.closing = true
	sessions := make([]*awsSftpSession, 0, len(bridge.sessions))
	for _, session := range bridge.sessions {
		sessions = append(sessions, session)
	}
	bridge.sessions = make(map[string]*awsSftpSession)
	bridge.mu.Unlock()

	for _, session := range sessions {
		session.close()
	}
	if bridge.core != nil {
		bridge.core.Shutdown()
	}
}

func (bridge *AwsSftpBridge) CreateSession(ctx context.Context, userID string, request awsSftpCreateSessionRequest) (awsSftpSessionResponse, error) {
	if !bridge.runtime.Enabled {
		return awsSftpSessionResponse{}, errors.New("AWS SFTP runtime is unavailable on this server")
	}
	if err := validateAwsSftpCreateSessionRequest(request); err != nil {
		return awsSftpSessionResponse{}, err
	}

	bridge.mu.RLock()
	closing := bridge.closing
	bridge.mu.RUnlock()
	if closing {
		return awsSftpSessionResponse{}, errors.New("AWS SFTP runtime bridge is shutting down")
	}

	tunnelID := "aws-sftp:" + uuid.NewString()
	bindPort, err := reserveLocalhostPort()
	if err != nil {
		return awsSftpSessionResponse{}, err
	}
	if err := bridge.core.StartSSMPortForward(tunnelID, uuid.NewString(), coretypes.SSMPortForwardStartPayload{
		ProfileName: "",
		Region:      request.Region,
		TargetType:  "instance",
		TargetID:    request.InstanceID,
		BindAddress: "127.0.0.1",
		BindPort:    bindPort,
		TargetKind:  "instance-port",
		TargetPort:  request.SSHPort,
		Env:         request.Env,
		UnsetEnv:    request.UnsetEnv,
	}); err != nil {
		return awsSftpSessionResponse{}, fmt.Errorf("start AWS SSM tunnel: %w", err)
	}
	tunnelStarted := true
	defer func() {
		if tunnelStarted {
			_ = bridge.core.StopSSMPortForward(tunnelID, uuid.NewString())
		}
	}()

	knownHostName := buildAwsSsmKnownHostName(request.ProfileName, request.Region, request.InstanceID)
	hostKey, err := probeHostKeyWithRetry(ctx, "127.0.0.1", bindPort, awsSftpTunnelTimeout)
	if err != nil {
		return awsSftpSessionResponse{}, err
	}
	hostKey.Host = knownHostName
	hostKey.Port = request.SSHPort
	if err := validateTrustedAwsSftpHostKey(hostKey, request.TrustedHostKeyBase64, request.TrustedHostKeysBase64); err != nil {
		return awsSftpSessionResponse{}, err
	}

	signer, publicKey, err := createAwsSftpEphemeralSigner()
	if err != nil {
		return awsSftpSessionResponse{}, err
	}
	if err := sendAwsSftpPublicKey(ctx, bridge.runtime.AWSPath, request, publicKey); err != nil {
		return awsSftpSessionResponse{}, err
	}

	sshClient, err := dialAwsSftpClient(ctx, "127.0.0.1", bindPort, request.SSHUsername, signer, hostKey.KeyBase64)
	if err != nil {
		return awsSftpSessionResponse{}, err
	}
	sftpClient, err := sftppkg.NewClient(
		sshClient,
		sftppkg.UseConcurrentReads(true),
		sftppkg.UseConcurrentWrites(true),
	)
	if err != nil {
		_ = sshClient.Close()
		return awsSftpSessionResponse{}, fmt.Errorf("create SFTP client: %w", err)
	}

	rootPath := "."
	if resolved, err := sftpClient.RealPath("."); err == nil && strings.TrimSpace(resolved) != "" {
		rootPath = resolved
	}

	session := &awsSftpSession{
		id:        uuid.NewString(),
		userID:    userID,
		hostID:    request.HostID,
		tunnelID:  tunnelID,
		sshClient: sshClient,
		sftp:      sftpClient,
		bridge:    bridge,
	}
	bridge.mu.Lock()
	if bridge.closing {
		bridge.mu.Unlock()
		session.close()
		return awsSftpSessionResponse{}, errors.New("AWS SFTP runtime bridge is shutting down")
	}
	bridge.sessions[session.id] = session
	bridge.mu.Unlock()
	tunnelStarted = false

	return awsSftpSessionResponse{
		SessionID:   session.id,
		Path:        rootPath,
		ConnectedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}, nil
}

func (bridge *AwsSftpBridge) CloseSession(userID, sessionID string) error {
	session, err := bridge.lookupSession(userID, sessionID)
	if err != nil {
		return err
	}
	session.close()
	return nil
}

func (bridge *AwsSftpBridge) List(userID, sessionID, targetPath string) (awsSftpListResponse, error) {
	session, err := bridge.lookupSession(userID, sessionID)
	if err != nil {
		return awsSftpListResponse{}, err
	}
	if strings.TrimSpace(targetPath) == "" {
		targetPath = "."
	}
	if resolved, err := session.sftp.RealPath(targetPath); err == nil && strings.TrimSpace(resolved) != "" {
		targetPath = resolved
	}
	items, err := session.sftp.ReadDir(targetPath)
	if err != nil {
		return awsSftpListResponse{}, err
	}
	entries := make([]awsSftpFileEntry, 0, len(items))
	for _, item := range items {
		entries = append(entries, toAwsSftpFileEntry(targetPath, item))
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].IsDirectory != entries[j].IsDirectory {
			return entries[i].IsDirectory
		}
		return entries[i].Name < entries[j].Name
	})
	return awsSftpListResponse{Path: targetPath, Entries: entries}, nil
}

func (bridge *AwsSftpBridge) Mkdir(userID, sessionID, targetPath string) error {
	session, err := bridge.lookupSession(userID, sessionID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(targetPath) == "" {
		return errors.New("path is required")
	}
	return session.sftp.Mkdir(targetPath)
}

func (bridge *AwsSftpBridge) Rename(userID, sessionID, sourcePath, targetPath string) error {
	session, err := bridge.lookupSession(userID, sessionID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(sourcePath) == "" || strings.TrimSpace(targetPath) == "" {
		return errors.New("sourcePath and targetPath are required")
	}
	return session.sftp.Rename(sourcePath, targetPath)
}

func (bridge *AwsSftpBridge) Chmod(userID, sessionID, targetPath string, permissions uint32) error {
	session, err := bridge.lookupSession(userID, sessionID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(targetPath) == "" {
		return errors.New("path is required")
	}
	return session.sftp.Chmod(targetPath, os.FileMode(permissions))
}

func (bridge *AwsSftpBridge) Delete(userID, sessionID, targetPath string) error {
	session, err := bridge.lookupSession(userID, sessionID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(targetPath) == "" {
		return errors.New("path is required")
	}
	info, err := session.sftp.Lstat(targetPath)
	if err != nil {
		return err
	}
	if info.IsDir() {
		return session.sftp.RemoveDirectory(targetPath)
	}
	return session.sftp.Remove(targetPath)
}

func (bridge *AwsSftpBridge) Read(userID, sessionID string, request awsSftpReadRequest) (awsSftpReadResponse, error) {
	session, err := bridge.lookupSession(userID, sessionID)
	if err != nil {
		return awsSftpReadResponse{}, err
	}
	if strings.TrimSpace(request.Path) == "" {
		return awsSftpReadResponse{}, errors.New("path is required")
	}
	length := request.Length
	if length <= 0 || length > awsSftpMaxChunkBytes {
		length = awsSftpMaxChunkBytes
	}
	file, err := session.sftp.Open(request.Path)
	if err != nil {
		return awsSftpReadResponse{}, err
	}
	defer file.Close()

	buffer := make([]byte, length)
	bytesRead, readErr := file.ReadAt(buffer, request.Offset)
	if readErr != nil && !errors.Is(readErr, io.EOF) {
		return awsSftpReadResponse{}, readErr
	}
	return awsSftpReadResponse{
		BytesBase64: base64.StdEncoding.EncodeToString(buffer[:bytesRead]),
		BytesRead:   bytesRead,
		EOF:         errors.Is(readErr, io.EOF) || bytesRead < length,
	}, nil
}

func (bridge *AwsSftpBridge) Write(userID, sessionID string, request awsSftpWriteRequest) error {
	session, err := bridge.lookupSession(userID, sessionID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(request.Path) == "" {
		return errors.New("path is required")
	}
	payload, err := base64.StdEncoding.DecodeString(request.BytesBase64)
	if err != nil {
		return fmt.Errorf("decode bytesBase64: %w", err)
	}
	if len(payload) > awsSftpMaxChunkBytes {
		return fmt.Errorf("chunk exceeds %d bytes", awsSftpMaxChunkBytes)
	}
	flags := os.O_CREATE | os.O_WRONLY
	if request.Offset == 0 {
		flags |= os.O_TRUNC
	}
	file, err := session.sftp.OpenFile(request.Path, flags)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = file.WriteAt(payload, request.Offset)
	return err
}

func (bridge *AwsSftpBridge) lookupSession(userID, sessionID string) (*awsSftpSession, error) {
	bridge.mu.RLock()
	session := bridge.sessions[sessionID]
	bridge.mu.RUnlock()
	if session == nil || session.userID != userID {
		return nil, errors.New("AWS SFTP session not found")
	}
	return session, nil
}

func (session *awsSftpSession) close() {
	session.closed.Do(func() {
		session.bridge.mu.Lock()
		delete(session.bridge.sessions, session.id)
		session.bridge.mu.Unlock()
		if session.sftp != nil {
			_ = session.sftp.Close()
		}
		if session.sshClient != nil {
			_ = session.sshClient.Close()
		}
		if session.tunnelID != "" && session.bridge.core != nil {
			_ = session.bridge.core.StopSSMPortForward(session.tunnelID, uuid.NewString())
		}
	})
}

func validateAwsSftpCreateSessionRequest(request awsSftpCreateSessionRequest) error {
	if strings.TrimSpace(request.HostID) == "" {
		return errors.New("hostId is required")
	}
	if strings.TrimSpace(request.ProfileName) == "" {
		return errors.New("profileName is required")
	}
	if strings.TrimSpace(request.Region) == "" {
		return errors.New("region is required")
	}
	if strings.TrimSpace(request.InstanceID) == "" {
		return errors.New("instanceId is required")
	}
	if strings.TrimSpace(request.AvailabilityZone) == "" {
		return errors.New("availabilityZone is required")
	}
	if strings.TrimSpace(request.SSHUsername) == "" {
		return errors.New("sshUsername is required")
	}
	if request.SSHPort <= 0 || request.SSHPort > 65535 {
		return errors.New("sshPort is invalid")
	}
	if len(request.Env) == 0 {
		return errors.New("AWS credential env is required")
	}
	return nil
}

func reserveLocalhostPort() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, fmt.Errorf("reserve localhost port: %w", err)
	}
	defer listener.Close()
	address, ok := listener.Addr().(*net.TCPAddr)
	if !ok || address.Port <= 0 {
		return 0, errors.New("reserve localhost port: invalid listener address")
	}
	return address.Port, nil
}

func probeHostKeyWithRetry(ctx context.Context, host string, port int, timeout time.Duration) (awsSftpHostKeyInfo, error) {
	deadline := time.Now().Add(timeout)
	var lastErr error
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return awsSftpHostKeyInfo{}, ctx.Err()
		default:
		}
		info, err := probeHostKey(ctx, host, port)
		if err == nil {
			return info, nil
		}
		lastErr = err
		time.Sleep(100 * time.Millisecond)
	}
	if lastErr != nil {
		return awsSftpHostKeyInfo{}, lastErr
	}
	return awsSftpHostKeyInfo{}, errors.New("timeout")
}

func probeHostKey(ctx context.Context, host string, port int) (awsSftpHostKeyInfo, error) {
	dialer := &net.Dialer{Timeout: awsSftpConnectTimeout}
	rawConn, err := dialer.DialContext(ctx, "tcp", fmt.Sprintf("%s:%d", host, port))
	if err != nil {
		return awsSftpHostKeyInfo{}, fmt.Errorf("probe host key dial: %w", err)
	}
	defer rawConn.Close()

	var result awsSftpHostKeyInfo
	config := &ssh.ClientConfig{
		User: "probe",
		HostKeyCallback: func(_ string, remote net.Addr, key ssh.PublicKey) error {
			result = awsSftpHostKeyInfo{
				Host:              host,
				Port:              port,
				Algorithm:         key.Type(),
				FingerprintSHA256: ssh.FingerprintSHA256(key),
				KeyBase64:         base64.StdEncoding.EncodeToString(key.Marshal()),
			}
			if remote != nil {
				result.RemoteIP = remote.String()
			}
			return errors.New("host key probed")
		},
		Timeout: awsSftpConnectTimeout,
	}
	_, _, _, err = ssh.NewClientConn(rawConn, fmt.Sprintf("%s:%d", host, port), config)
	if result.KeyBase64 != "" {
		return result, nil
	}
	if err != nil {
		return awsSftpHostKeyInfo{}, fmt.Errorf("probe host key: %w", err)
	}
	return awsSftpHostKeyInfo{}, errors.New("probe host key: empty result")
}

func validateTrustedAwsSftpHostKey(info awsSftpHostKeyInfo, trustedHostKeyBase64 string, trustedHostKeysBase64 []string) error {
	candidates := make([]string, 0, len(trustedHostKeysBase64)+1)
	for _, value := range trustedHostKeysBase64 {
		value = strings.TrimSpace(value)
		if value != "" {
			candidates = append(candidates, value)
		}
	}
	if len(candidates) == 0 && strings.TrimSpace(trustedHostKeyBase64) != "" {
		candidates = append(candidates, strings.TrimSpace(trustedHostKeyBase64))
	}
	if len(candidates) == 0 {
		return &awsSftpHostKeyChallengeError{response: awsSftpHostKeyChallengeResponse{
			Code:    "host_key_required",
			Message: "Host key trust is required.",
			Info:    info,
		}}
	}
	actual, actualErr := base64.StdEncoding.DecodeString(info.KeyBase64)
	if actualErr == nil {
		for _, candidate := range candidates {
			expected, err := base64.StdEncoding.DecodeString(candidate)
			if err == nil && bytes.Equal(expected, actual) {
				return nil
			}
		}
	}
	if actualErr != nil {
		return &awsSftpHostKeyChallengeError{response: awsSftpHostKeyChallengeResponse{
			Code:    "host_key_mismatch",
			Message: "Host key changed.",
			Info:    info,
		}}
	}
	return &awsSftpHostKeyChallengeError{response: awsSftpHostKeyChallengeResponse{
		Code:    "host_key_mismatch",
		Message: "Host key changed.",
		Info:    info,
	}}
}

func createAwsSftpEphemeralSigner() (ssh.Signer, string, error) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, "", fmt.Errorf("generate ephemeral SSH key: %w", err)
	}
	signer, err := ssh.NewSignerFromKey(privateKey)
	if err != nil {
		return nil, "", fmt.Errorf("create ephemeral SSH signer: %w", err)
	}
	return signer, strings.TrimSpace(string(ssh.MarshalAuthorizedKey(signer.PublicKey()))), nil
}

func sendAwsSftpPublicKey(ctx context.Context, awsPath string, request awsSftpCreateSessionRequest, publicKey string) error {
	if strings.TrimSpace(awsPath) == "" {
		return errors.New("aws executable not found")
	}
	commandCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	args := []string{
		"ec2-instance-connect",
		"send-ssh-public-key",
		"--region", request.Region,
		"--instance-id", request.InstanceID,
		"--availability-zone", request.AvailabilityZone,
		"--instance-os-user", request.SSHUsername,
		"--ssh-public-key", publicKey,
		"--output", "json",
	}
	cmd := exec.CommandContext(commandCtx, awsPath, args...)
	cmd.Env = mergeAwsSftpChildEnv(request.Env, request.UnsetEnv)
	output, err := cmd.CombinedOutput()
	if commandCtx.Err() == context.DeadlineExceeded {
		return errors.New("EC2 Instance Connect public key send timed out")
	}
	if err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = err.Error()
		}
		return fmt.Errorf("send EC2 Instance Connect public key: %s", message)
	}
	var payload struct {
		Success bool   `json:"Success"`
		Message string `json:"Message"`
	}
	if err := json.Unmarshal(output, &payload); err != nil {
		return fmt.Errorf("decode EC2 Instance Connect response: %w", err)
	}
	if !payload.Success {
		if strings.TrimSpace(payload.Message) != "" {
			return errors.New(strings.TrimSpace(payload.Message))
		}
		return errors.New("EC2 Instance Connect public key was rejected")
	}
	return nil
}

func dialAwsSftpClient(ctx context.Context, host string, port int, username string, signer ssh.Signer, trustedHostKeyBase64 string) (*ssh.Client, error) {
	expected, err := base64.StdEncoding.DecodeString(trustedHostKeyBase64)
	if err != nil {
		return nil, fmt.Errorf("decode trusted host key: %w", err)
	}
	config := &ssh.ClientConfig{
		User: username,
		Auth: []ssh.AuthMethod{
			ssh.PublicKeys(signer),
		},
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			if !bytes.Equal(key.Marshal(), expected) {
				return errors.New("host key mismatch")
			}
			return nil
		},
		Timeout: awsSftpConnectTimeout,
	}
	dialer := &net.Dialer{Timeout: awsSftpConnectTimeout, KeepAlive: 30 * time.Second}
	rawConn, err := dialer.DialContext(ctx, "tcp", fmt.Sprintf("%s:%d", host, port))
	if err != nil {
		return nil, fmt.Errorf("dial SFTP tunnel: %w", err)
	}
	conn, chans, reqs, err := ssh.NewClientConn(rawConn, fmt.Sprintf("%s:%d", host, port), config)
	if err != nil {
		_ = rawConn.Close()
		return nil, fmt.Errorf("ssh handshake failed: %w", err)
	}
	return ssh.NewClient(conn, chans, reqs), nil
}

func mergeAwsSftpChildEnv(overrides map[string]string, unsetKeys []string) []string {
	env := os.Environ()
	env = append(env, "AWS_PAGER=", "AWS_CLI_AUTO_PROMPT=off")
	unset := make(map[string]struct{}, len(unsetKeys))
	for _, key := range unsetKeys {
		key = strings.TrimSpace(key)
		if key != "" {
			unset[key] = struct{}{}
		}
	}
	overrideLookup := make(map[string]string, len(overrides))
	for key, value := range overrides {
		key = strings.TrimSpace(key)
		if key != "" {
			overrideLookup[key] = key + "=" + value
		}
	}
	next := make([]string, 0, len(env)+len(overrides))
	for _, entry := range env {
		key, _, ok := strings.Cut(entry, "=")
		if !ok {
			next = append(next, entry)
			continue
		}
		if _, shouldUnset := unset[key]; shouldUnset {
			continue
		}
		if override, shouldOverride := overrideLookup[key]; shouldOverride {
			next = append(next, override)
			delete(overrideLookup, key)
			continue
		}
		next = append(next, entry)
	}
	for _, override := range overrideLookup {
		next = append(next, override)
	}
	return next
}

func toAwsSftpFileEntry(parentPath string, info os.FileInfo) awsSftpFileEntry {
	mode := info.Mode()
	kind := "file"
	if info.IsDir() {
		kind = "folder"
	} else if mode&os.ModeSymlink != 0 {
		kind = "symlink"
	}
	return awsSftpFileEntry{
		Name:        info.Name(),
		Path:        path.Join(parentPath, info.Name()),
		IsDirectory: info.IsDir(),
		Size:        info.Size(),
		Mtime:       info.ModTime().UTC().Format(time.RFC3339),
		Kind:        kind,
		Permissions: mode.String(),
	}
}

func buildAwsSsmKnownHostName(profileName, region, instanceID string) string {
	return fmt.Sprintf("aws-ssm:%s:%s:%s", profileName, region, instanceID)
}
