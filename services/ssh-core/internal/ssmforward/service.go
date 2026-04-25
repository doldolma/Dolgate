package ssmforward

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"dolssh/services/ssh-core/internal/protocol"
)

const startupGracePeriod = 500 * time.Millisecond

var stopPortReleaseTimeout = 5 * time.Second
var stopRequestWaitTimeout = stopPortReleaseTimeout + time.Second

type EventEmitter func(protocol.Event)

type sessionExit struct {
	ExitCode int
	Signal   string
}

type runtimeRunner interface {
	Wait() (sessionExit, error)
	Kill() error
	Close() error
	ErrorMessage() string
}

type bindPortAwareRunner interface {
	ActualBindPort() int
	SetBindPortResolvedCallback(func(int))
}

type runnerFactory func(protocol.SSMPortForwardStartPayload) (runtimeRunner, error)

type runtimeHandle struct {
	runner        runtimeRunner
	done          chan struct{}
	doneOnce      sync.Once
	stateMu       sync.RWMutex
	stopRequested bool
	stopRequestID string
	bindAddress   string
	bindPort      int
}

type Service struct {
	mu           sync.RWMutex
	runtimes     map[string]*runtimeHandle
	emit         EventEmitter
	createRunner runnerFactory
}

func New(emit EventEmitter) *Service {
	return NewWithRunnerFactory(emit, defaultRunnerFactory)
}

func NewWithRunnerFactory(emit EventEmitter, createRunner runnerFactory) *Service {
	if createRunner == nil {
		createRunner = defaultRunnerFactory
	}

	return &Service{
		runtimes:     make(map[string]*runtimeHandle),
		emit:         emit,
		createRunner: createRunner,
	}
}

func (s *Service) Shutdown() {
	s.mu.Lock()
	runtimes := make([]*runtimeHandle, 0, len(s.runtimes))
	for _, handle := range s.runtimes {
		runtimes = append(runtimes, handle)
	}
	s.runtimes = make(map[string]*runtimeHandle)
	s.mu.Unlock()

	for _, handle := range runtimes {
		_ = handle.runner.Kill()
		_ = handle.runner.Close()
		handle.closeDone()
	}
}

func (s *Service) Start(ruleID, requestID string, payload protocol.SSMPortForwardStartPayload) error {
	if ruleID == "" {
		return fmt.Errorf("ssm forward runtime id is required")
	}

	s.mu.RLock()
	_, exists := s.runtimes[ruleID]
	s.mu.RUnlock()
	if exists {
		return fmt.Errorf("ssm port forward %s is already running", ruleID)
	}

	runner, err := s.createRunner(payload)
	if err != nil {
		return err
	}

	handle := &runtimeHandle{
		runner:      runner,
		done:        make(chan struct{}),
		bindAddress: resolvedBindAddress(payload.BindAddress),
		bindPort:    payload.BindPort,
	}
	s.mu.Lock()
	s.runtimes[ruleID] = handle
	s.mu.Unlock()

	bindPort := payload.BindPort
	if awareRunner, ok := runner.(bindPortAwareRunner); ok {
		if actualBindPort := awareRunner.ActualBindPort(); actualBindPort > 0 {
			bindPort = actualBindPort
			handle.setBindPort(actualBindPort)
		}
		awareRunner.SetBindPortResolvedCallback(func(actualBindPort int) {
			if actualBindPort <= 0 || !s.hasRuntime(ruleID) {
				return
			}
			handle.setBindPort(actualBindPort)
			s.emit(protocol.Event{
				Type:       protocol.EventPortForwardStarted,
				RequestID:  requestID,
				EndpointID: ruleID,
				Payload: protocol.PortForwardStartedPayload{
					Transport:   "aws-ssm",
					Status:      "running",
					Mode:        "local",
					Method:      "ssm-remote-host",
					BindAddress: resolvedBindAddress(payload.BindAddress),
					BindPort:    actualBindPort,
				},
			})
		})
	}

	s.emit(protocol.Event{
		Type:       protocol.EventPortForwardStarted,
		RequestID:  requestID,
		EndpointID: ruleID,
		Payload: protocol.PortForwardStartedPayload{
			Transport:   "aws-ssm",
			Status:      "running",
			Mode:        "local",
			Method:      "ssm-remote-host",
			BindAddress: resolvedBindAddress(payload.BindAddress),
			BindPort:    bindPort,
		},
	})

	go s.waitForRuntime(ruleID)
	return nil
}

func (s *Service) Stop(ruleID, requestID string) error {
	handle, err := s.getRuntime(ruleID)
	if err != nil {
		s.emit(protocol.Event{
			Type:       protocol.EventPortForwardStopped,
			RequestID:  requestID,
			EndpointID: ruleID,
			Payload: protocol.AckPayload{
				Message: "ssm port forward stopped",
			},
		})
		return nil
	}

	if err := handle.markStopRequested(requestID); err != nil {
		return err
	}
	if err := handle.runner.Kill(); err != nil {
		handle.clearStopRequested()
		return fmt.Errorf("stop aws ssm port forward: %w", err)
	}

	select {
	case <-handle.done:
		return nil
	case <-time.After(stopRequestWaitTimeout):
		handle.clearStopRequested()
		return fmt.Errorf("timed out waiting for aws ssm port forward %s to stop", ruleID)
	}
}

func (s *Service) waitForRuntime(ruleID string) {
	handle, err := s.getRuntime(ruleID)
	if err != nil {
		return
	}
	defer handle.closeDone()

	exit, waitErr := handle.runner.Wait()
	if !s.hasRuntime(ruleID) {
		return
	}

	stopRequested, stopRequestID := handle.stopState()
	if stopRequested {
		bindAddress, bindPort := handle.bindTarget()
		if err := waitForPortRelease(bindAddress, bindPort, stopPortReleaseTimeout); err != nil {
			s.failRuntime(
				ruleID,
				stopRequestID,
				fmt.Sprintf("AWS SSM port forward stop timed out: %v", err),
			)
			return
		}
		s.removeRuntime(ruleID)
		_ = handle.runner.Close()
		s.emit(protocol.Event{
			Type:       protocol.EventPortForwardStopped,
			RequestID:  stopRequestID,
			EndpointID: ruleID,
			Payload: protocol.AckPayload{
				Message: "ssm port forward stopped",
			},
		})
		return
	}

	s.failRuntime(ruleID, "", describeExit(exit, waitErr, handle.runner.ErrorMessage()))
}

func (s *Service) failRuntime(ruleID string, requestID string, message string) {
	handle := s.removeRuntime(ruleID)
	if handle != nil {
		_ = handle.runner.Close()
	}
	if strings.TrimSpace(message) == "" {
		message = "AWS SSM port forward가 종료되었습니다."
	}

	s.emit(protocol.Event{
		Type:       protocol.EventPortForwardError,
		RequestID:  requestID,
		EndpointID: ruleID,
		Payload: protocol.ErrorPayload{
			Message: message,
		},
	})
}

func (s *Service) hasRuntime(ruleID string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, ok := s.runtimes[ruleID]
	return ok
}

func (s *Service) getRuntime(ruleID string) (*runtimeHandle, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	handle, ok := s.runtimes[ruleID]
	if !ok {
		return nil, fmt.Errorf("ssm port forward %s not found", ruleID)
	}
	return handle, nil
}

func (s *Service) removeRuntime(ruleID string) *runtimeHandle {
	s.mu.Lock()
	defer s.mu.Unlock()
	handle := s.runtimes[ruleID]
	delete(s.runtimes, ruleID)
	return handle
}

func (h *runtimeHandle) closeDone() {
	h.doneOnce.Do(func() {
		close(h.done)
	})
}

func (h *runtimeHandle) markStopRequested(requestID string) error {
	h.stateMu.Lock()
	defer h.stateMu.Unlock()
	if h.stopRequested {
		return fmt.Errorf("ssm port forward stop is already in progress")
	}
	h.stopRequested = true
	h.stopRequestID = requestID
	return nil
}

func (h *runtimeHandle) clearStopRequested() {
	h.stateMu.Lock()
	defer h.stateMu.Unlock()
	h.stopRequested = false
	h.stopRequestID = ""
}

func (h *runtimeHandle) stopState() (bool, string) {
	h.stateMu.RLock()
	defer h.stateMu.RUnlock()
	return h.stopRequested, h.stopRequestID
}

func (h *runtimeHandle) setBindPort(bindPort int) {
	if bindPort <= 0 {
		return
	}
	h.stateMu.Lock()
	defer h.stateMu.Unlock()
	h.bindPort = bindPort
}

func (h *runtimeHandle) bindTarget() (string, int) {
	h.stateMu.RLock()
	defer h.stateMu.RUnlock()
	return resolveProbeAddress(h.bindAddress), h.bindPort
}

type commandRunner struct {
	cmd         *exec.Cmd
	stdout      io.ReadCloser
	stderr      io.ReadCloser
	waitCh      chan waitResult
	treeKiller  processTreeKiller
	messageMu   sync.RWMutex
	lastMessage string
	bindPortMu  sync.RWMutex
	actualPort  int
	onBindPort  func(int)
}

type waitResult struct {
	exit sessionExit
	err  error
}

func defaultRunnerFactory(payload protocol.SSMPortForwardStartPayload) (runtimeRunner, error) {
	awsPath, pluginPath, err := resolveRuntimeTools()
	if err != nil {
		return nil, err
	}

	args, err := buildStartArgs(payload)
	if err != nil {
		return nil, err
	}

	cmd := exec.CommandContext(context.Background(), awsPath, args...)
	cmd.Env = mergeChildEnv(
		buildRuntimePathValue(filepath.Dir(awsPath), filepath.Dir(pluginPath)),
		payload.Env,
		payload.UnsetEnv,
	)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("capture aws ssm stdout: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, fmt.Errorf("capture aws ssm stderr: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start aws ssm port forward: %w", err)
	}

	treeKiller, err := attachProcessTreeKiller(cmd)
	if err != nil {
		_ = ignoreProcessDone(cmd.Process.Kill())
		_ = cmd.Wait()
		_ = stdout.Close()
		_ = stderr.Close()
		return nil, fmt.Errorf("prepare aws ssm process tree: %w", err)
	}

	runner := &commandRunner{
		cmd:        cmd,
		stdout:     stdout,
		stderr:     stderr,
		waitCh:     make(chan waitResult, 1),
		treeKiller: treeKiller,
	}

	go runner.captureOutput(stdout)
	go runner.captureOutput(stderr)
	go func() {
		err := cmd.Wait()
		runner.waitCh <- waitResult{exit: describeCmdExit(cmd.ProcessState), err: err}
	}()

	select {
	case result := <-runner.waitCh:
		_ = runner.Close()
		return nil, errors.New(describeExit(result.exit, result.err, runner.ErrorMessage()))
	case <-time.After(startupGracePeriod):
		return runner, nil
	}
}

func (r *commandRunner) Wait() (sessionExit, error) {
	result := <-r.waitCh
	return result.exit, result.err
}

func (r *commandRunner) Kill() error {
	if r.treeKiller != nil {
		return r.treeKiller.Kill()
	}
	if r.cmd == nil || r.cmd.Process == nil {
		return nil
	}
	return ignoreProcessDone(r.cmd.Process.Kill())
}

func (r *commandRunner) Close() error {
	var closeErr error
	if r.stdout != nil {
		if err := r.stdout.Close(); err != nil && closeErr == nil {
			closeErr = err
		}
	}
	if r.stderr != nil {
		if err := r.stderr.Close(); err != nil && closeErr == nil {
			closeErr = err
		}
	}
	if r.treeKiller != nil {
		if err := r.treeKiller.Close(); err != nil && closeErr == nil {
			closeErr = err
		}
	}
	return closeErr
}

func (r *commandRunner) ErrorMessage() string {
	r.messageMu.RLock()
	defer r.messageMu.RUnlock()
	return r.lastMessage
}

func (r *commandRunner) ActualBindPort() int {
	r.bindPortMu.RLock()
	defer r.bindPortMu.RUnlock()
	return r.actualPort
}

func (r *commandRunner) SetBindPortResolvedCallback(callback func(int)) {
	r.bindPortMu.Lock()
	r.onBindPort = callback
	actualPort := r.actualPort
	r.bindPortMu.Unlock()
	if callback != nil && actualPort > 0 {
		callback(actualPort)
	}
}

func (r *commandRunner) captureOutput(reader io.Reader) {
	scanner := bufio.NewScanner(reader)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		r.messageMu.Lock()
		r.lastMessage = line
		r.messageMu.Unlock()
		if bindPort := parseStartedBindPort(line); bindPort > 0 {
			r.bindPortMu.Lock()
			previousPort := r.actualPort
			r.actualPort = bindPort
			callback := r.onBindPort
			r.bindPortMu.Unlock()
			if callback != nil && previousPort != bindPort {
				callback(bindPort)
			}
		}
	}
}

var startedBindPortPattern = regexp.MustCompile(`(?i)\bport\s+(\d+)\s+opened\b`)

func parseStartedBindPort(line string) int {
	match := startedBindPortPattern.FindStringSubmatch(line)
	if len(match) < 2 {
		return 0
	}
	port, err := strconv.Atoi(match[1])
	if err != nil || port <= 0 {
		return 0
	}
	return port
}

func buildStartArgs(payload protocol.SSMPortForwardStartPayload) ([]string, error) {
	parameters := map[string][]string{
		"portNumber":      {strconv.Itoa(payload.TargetPort)},
		"localPortNumber": {strconv.Itoa(payload.BindPort)},
	}

	documentName := "AWS-StartPortForwardingSession"
	if payload.TargetKind == "remote-host" {
		if strings.TrimSpace(payload.RemoteHost) == "" {
			return nil, fmt.Errorf("remote host is required for remote-host target")
		}
		documentName = "AWS-StartPortForwardingSessionToRemoteHost"
		parameters["host"] = []string{strings.TrimSpace(payload.RemoteHost)}
	}

	rawParameters, err := json.Marshal(parameters)
	if err != nil {
		return nil, fmt.Errorf("marshal ssm forward parameters: %w", err)
	}

	args := []string{
		"ssm",
		"start-session",
		"--target",
		payload.TargetID,
		"--document-name",
		documentName,
		"--parameters",
		string(rawParameters),
	}
	if strings.TrimSpace(payload.ProfileName) != "" {
		args = append(args, "--profile", strings.TrimSpace(payload.ProfileName))
	}
	if strings.TrimSpace(payload.Region) != "" {
		args = append(args, "--region", strings.TrimSpace(payload.Region))
	}
	return args, nil
}

func resolvedBindAddress(bindAddress string) string {
	if strings.TrimSpace(bindAddress) != "" {
		return strings.TrimSpace(bindAddress)
	}
	return "127.0.0.1"
}

func describeExit(exit sessionExit, err error, message string) string {
	if strings.TrimSpace(message) != "" {
		return strings.TrimSpace(message)
	}
	if err != nil {
		return err.Error()
	}
	if exit.Signal != "" {
		return fmt.Sprintf("AWS SSM port forward exited with signal %s", exit.Signal)
	}
	if exit.ExitCode != 0 {
		return fmt.Sprintf("AWS SSM port forward exited with code %d", exit.ExitCode)
	}
	return ""
}

func describeCmdExit(state *os.ProcessState) sessionExit {
	if state == nil {
		return sessionExit{}
	}
	exit := sessionExit{ExitCode: state.ExitCode()}
	return exit
}

func ignoreProcessDone(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, os.ErrProcessDone) {
		return nil
	}
	return err
}

func resolveProbeAddress(bindAddress string) string {
	switch strings.TrimSpace(bindAddress) {
	case "", "0.0.0.0":
		return "127.0.0.1"
	case "::", "[::]":
		return "::1"
	default:
		return strings.TrimSpace(bindAddress)
	}
}

func waitForPortRelease(bindAddress string, bindPort int, timeout time.Duration) error {
	if bindPort <= 0 {
		return nil
	}

	address := net.JoinHostPort(bindAddress, strconv.Itoa(bindPort))
	deadline := time.Now().Add(timeout)
	for {
		conn, err := net.DialTimeout("tcp", address, 250*time.Millisecond)
		if err != nil {
			return nil
		}
		_ = conn.Close()

		if time.Now().After(deadline) {
			return fmt.Errorf("local port %s is still accepting connections", address)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func splitPathEnv() []string {
	rawPath := os.Getenv("PATH")
	if rawPath == "" {
		return nil
	}
	return strings.FieldsFunc(rawPath, func(r rune) bool { return r == os.PathListSeparator })
}

func buildRuntimePathValue(preferredDirs ...string) string {
	entries := make([]string, 0, len(preferredDirs)+8)
	seen := make(map[string]struct{})
	appendUnique := func(entry string) {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			return
		}
		key := entry
		if processPlatformIsWindows() {
			key = strings.ToLower(entry)
		}
		if _, ok := seen[key]; ok {
			return
		}
		seen[key] = struct{}{}
		entries = append(entries, entry)
	}

	for _, preferredDir := range preferredDirs {
		appendUnique(preferredDir)
	}
	for _, entry := range splitPathEnv() {
		appendUnique(entry)
	}
	return strings.Join(entries, string(os.PathListSeparator))
}

func mergeChildEnv(pathValue string, overrides map[string]string, unsetKeys []string) []string {
	env := os.Environ()
	env = append(env, "AWS_PAGER=")
	unset := make(map[string]struct{}, len(unsetKeys))
	for _, key := range unsetKeys {
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		unset[envKeyLookup(key)] = struct{}{}
	}

	overrideLookup := make(map[string]string, len(overrides))
	for key, value := range overrides {
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		overrideLookup[envKeyLookup(key)] = key + "=" + value
	}

	pathReplaced := false
	next := make([]string, 0, len(env)+len(overrides)+1)
	for _, entry := range env {
		key, _, found := strings.Cut(entry, "=")
		if !found {
			next = append(next, entry)
			continue
		}
		lookupKey := envKeyLookup(key)
		if _, shouldUnset := unset[lookupKey]; shouldUnset {
			continue
		}
		if override, shouldOverride := overrideLookup[lookupKey]; shouldOverride {
			next = append(next, override)
			delete(overrideLookup, lookupKey)
			continue
		}
		if pathKeyMatches(key) {
			if pathValue != "" {
				next = append(next, fmt.Sprintf("%s=%s", key, pathValue))
				pathReplaced = true
			} else {
				next = append(next, entry)
			}
			continue
		}
		next = append(next, entry)
	}
	if pathValue != "" && !pathReplaced {
		next = append(next, fmt.Sprintf("PATH=%s", pathValue))
	}
	for _, override := range overrideLookup {
		next = append(next, override)
	}
	return next
}

func envKeyLookup(key string) string {
	if processPlatformIsWindows() {
		return strings.ToUpper(key)
	}
	return key
}

func pathKeyMatches(key string) bool {
	if processPlatformIsWindows() {
		return strings.EqualFold(key, "PATH")
	}
	return key == "PATH"
}
