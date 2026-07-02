package ssmforward

import (
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"dolssh/services/ssh-core/internal/protocol"
)

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

func defaultRunnerFactory(payload protocol.SSMPortForwardStartPayload) (runtimeRunner, error) {
	if payload.StreamURL == "" || payload.TokenValue == "" {
		return nil, errors.New(
			"AWS SSM 포트 포워딩 세션 토큰이 없습니다. 앱을 다시 시작한 뒤 다시 시도해 주세요.",
		)
	}
	return startDataChannelForwardRunner(payload)
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

