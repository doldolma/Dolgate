package ssmforward

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"dolssh/services/ssh-core/internal/protocol"
)

const startupGracePeriod = 500 * time.Millisecond

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

type runnerFactory func(protocol.SSMPortForwardStartPayload) (runtimeRunner, error)

type runtimeHandle struct {
	runner        runtimeRunner
	stopRequested bool
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

	handle := &runtimeHandle{runner: runner}
	s.mu.Lock()
	s.runtimes[ruleID] = handle
	s.mu.Unlock()

	s.emit(protocol.Event{
		Type:       protocol.EventPortForwardStarted,
		RequestID:  requestID,
		EndpointID: ruleID,
		Payload: protocol.PortForwardStartedPayload{
			Transport:   "aws-ssm",
			Status:      "running",
			Mode:        "local",
			BindAddress: resolvedBindAddress(payload.BindAddress),
			BindPort:    payload.BindPort,
		},
	})

	go s.waitForRuntime(ruleID)
	return nil
}

func (s *Service) Stop(ruleID, requestID string) error {
	handle := s.removeRuntime(ruleID)
	if handle != nil {
		handle.stopRequested = true
		_ = handle.runner.Kill()
		_ = handle.runner.Close()
	}

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

func (s *Service) waitForRuntime(ruleID string) {
	handle, err := s.getRuntime(ruleID)
	if err != nil {
		return
	}

	exit, waitErr := handle.runner.Wait()
	if !s.hasRuntime(ruleID) {
		return
	}

	if handle.stopRequested {
		s.removeRuntime(ruleID)
		_ = handle.runner.Close()
		return
	}

	s.failRuntime(ruleID, describeExit(exit, waitErr, handle.runner.ErrorMessage()))
}

func (s *Service) failRuntime(ruleID string, message string) {
	handle := s.removeRuntime(ruleID)
	if handle != nil {
		_ = handle.runner.Close()
	}
	if strings.TrimSpace(message) == "" {
		message = "AWS SSM port forward가 종료되었습니다."
	}

	s.emit(protocol.Event{
		Type:       protocol.EventPortForwardError,
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

type commandRunner struct {
	cmd         *exec.Cmd
	stdout      io.ReadCloser
	stderr      io.ReadCloser
	waitCh      chan waitResult
	messageMu   sync.RWMutex
	lastMessage string
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
	cmd.Env = mergeChildEnv(buildRuntimePathValue(filepath.Dir(awsPath), filepath.Dir(pluginPath)))

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

	runner := &commandRunner{
		cmd:    cmd,
		stdout: stdout,
		stderr: stderr,
		waitCh: make(chan waitResult, 1),
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
	if r.cmd == nil || r.cmd.Process == nil {
		return nil
	}
	return ignoreProcessDone(r.cmd.Process.Kill())
}

func (r *commandRunner) Close() error {
	if r.stdout != nil {
		_ = r.stdout.Close()
	}
	if r.stderr != nil {
		_ = r.stderr.Close()
	}
	return nil
}

func (r *commandRunner) ErrorMessage() string {
	r.messageMu.RLock()
	defer r.messageMu.RUnlock()
	return r.lastMessage
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
	}
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
		payload.InstanceID,
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

func mergeChildEnv(pathValue string) []string {
	env := os.Environ()
	env = append(env, "AWS_PAGER=")
	if pathValue == "" {
		return env
	}
	replaced := false
	for index, entry := range env {
		key, _, found := strings.Cut(entry, "=")
		if !found {
			continue
		}
		if pathKeyMatches(key) {
			env[index] = fmt.Sprintf("%s=%s", key, pathValue)
			replaced = true
		}
	}
	if !replaced {
		env = append(env, fmt.Sprintf("PATH=%s", pathValue))
	}
	return env
}

func pathKeyMatches(key string) bool {
	if processPlatformIsWindows() {
		return strings.EqualFold(key, "PATH")
	}
	return key == "PATH"
}
