package containers

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"dolssh/services/ssh-core/internal/protocol"
	"dolssh/services/ssh-core/internal/sshcmd"
	"dolssh/services/ssh-core/internal/sshconn"
)

type EventEmitter func(protocol.Event)

type endpointHandle struct {
	client         *ssh.Client
	target         sshconn.Target
	loginShell     string
	runtime        string
	runtimeCommand string
}

type pendingChallenge struct {
	endpointID string
	responses  chan []string
}

type Service struct {
	mu                sync.RWMutex
	endpoints         map[string]*endpointHandle
	pendingChallenges map[string]*pendingChallenge
	emit              EventEmitter
}

var dockerRuntimeCandidatePaths = []string{
	"/var/packages/ContainerManager/target/usr/bin/docker",
	"/var/packages/Docker/target/usr/bin/docker",
	"/usr/bin/docker",
	"/usr/local/bin/docker",
	"/bin/docker",
}

var podmanRuntimeCandidatePaths = []string{
	"/usr/bin/podman",
	"/usr/local/bin/podman",
	"/bin/podman",
}

func New(emit EventEmitter) *Service {
	return &Service{
		endpoints:         make(map[string]*endpointHandle),
		pendingChallenges: make(map[string]*pendingChallenge),
		emit:              emit,
	}
}

func (s *Service) Shutdown() {
	s.mu.Lock()
	handles := make([]*endpointHandle, 0, len(s.endpoints))
	for _, handle := range s.endpoints {
		handles = append(handles, handle)
	}
	s.endpoints = make(map[string]*endpointHandle)

	challenges := make([]*pendingChallenge, 0, len(s.pendingChallenges))
	for _, challenge := range s.pendingChallenges {
		challenges = append(challenges, challenge)
	}
	s.pendingChallenges = make(map[string]*pendingChallenge)
	s.mu.Unlock()

	for _, handle := range handles {
		closeEndpointClient(handle)
	}
	for _, challenge := range challenges {
		close(challenge.responses)
	}
}

func (s *Service) Connect(endpointID, requestID string, payload protocol.ContainersConnectPayload) error {
	target := sshconn.Target{
		Host:                 payload.Host,
		Port:                 payload.Port,
		Username:             payload.Username,
		AuthType:             payload.AuthType,
		Password:             payload.Password,
		PrivateKeyPEM:        payload.PrivateKeyPEM,
		CertificateText:      payload.CertificateText,
		Passphrase:           payload.Passphrase,
		TrustedHostKeyBase64: payload.TrustedHostKeyBase64,
	}
	client, err := s.dialTarget(endpointID, requestID, target)
	if err != nil {
		return err
	}

	loginShell, err := detectLoginShell(client)
	if err != nil {
		closeEndpointClient(&endpointHandle{client: client})
		return err
	}

	runtime, runtimeCommand, unsupportedReason, err := detectRuntime(client, loginShell)
	if err != nil {
		closeEndpointClient(&endpointHandle{client: client})
		return err
	}
	if unsupportedReason != "" {
		closeEndpointClient(&endpointHandle{client: client})
		s.emit(protocol.Event{
			Type:       protocol.EventContainersConnected,
			RequestID:  requestID,
			EndpointID: endpointID,
			Payload: protocol.ContainersConnectedPayload{
				UnsupportedReason: unsupportedReason,
			},
		})
		return nil
	}

	handle := &endpointHandle{
		client:         client,
		target:         target,
		loginShell:     loginShell,
		runtime:        runtime,
		runtimeCommand: runtimeCommand,
	}

	s.mu.Lock()
	s.endpoints[endpointID] = handle
	s.mu.Unlock()

	s.emit(protocol.Event{
		Type:       protocol.EventContainersConnected,
		RequestID:  requestID,
		EndpointID: endpointID,
		Payload: protocol.ContainersConnectedPayload{
			Runtime:        runtime,
			RuntimeCommand: runtimeCommand,
		},
	})

	return nil
}

func (s *Service) Disconnect(endpointID, requestID string) error {
	handle, _ := s.removeEndpoint(endpointID)
	closeEndpointClient(handle)
	for _, challenge := range s.removePendingChallengesForEndpoint(endpointID) {
		close(challenge.responses)
	}

	s.emit(protocol.Event{
		Type:       protocol.EventContainersDisconnected,
		RequestID:  requestID,
		EndpointID: endpointID,
		Payload: protocol.AckPayload{
			Message: "containers endpoint disconnected",
		},
	})
	return nil
}

func (s *Service) TakeClient(endpointID string) (*ssh.Client, error) {
	handle, _ := s.removeEndpoint(endpointID)
	if handle == nil || handle.client == nil {
		for _, challenge := range s.removePendingChallengesForEndpoint(endpointID) {
			close(challenge.responses)
		}
		return nil, fmt.Errorf("containers endpoint %s not found", endpointID)
	}
	client := handle.client
	handle.client = nil
	for _, challenge := range s.removePendingChallengesForEndpoint(endpointID) {
		close(challenge.responses)
	}
	return client, nil
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

func (s *Service) List(endpointID, requestID string) error {
	handle, err := s.getEndpoint(endpointID)
	if err != nil {
		return err
	}

	const containerListFormat = "{{.ID}}\t{{.Image}}\t{{.Status}}\t{{.CreatedAt}}\t{{.Ports}}\t{{.Names}}"
	command := fmt.Sprintf(
		`%s ps -a --no-trunc --format %s`,
		sshcmd.QuotePosix(handle.runtimeCommand),
		sshcmd.QuotePosix(containerListFormat),
	)
	stdout, err := s.runEndpointCommand(handle, command)
	if err != nil {
		return err
	}

	items := make([]protocol.ContainerSummary, 0)
	for _, line := range splitOutputLines(string(stdout)) {
		fields := strings.SplitN(line, "\t", 6)
		if len(fields) != 6 {
			return fmt.Errorf("failed to parse container list item: %s", line)
		}
		items = append(items, protocol.ContainerSummary{
			ID:        fields[0],
			Name:      fields[5],
			Runtime:   handle.runtime,
			Image:     fields[1],
			Status:    fields[2],
			CreatedAt: fields[3],
			Ports:     fields[4],
		})
	}
	sort.Slice(items, func(i, j int) bool {
		return items[i].Name < items[j].Name
	})

	s.emit(protocol.Event{
		Type:       protocol.EventContainersListed,
		RequestID:  requestID,
		EndpointID: endpointID,
		Payload: protocol.ContainersListedPayload{
			Runtime:    handle.runtime,
			Containers: items,
		},
	})
	return nil
}

func (s *Service) Inspect(endpointID, requestID string, payload protocol.ContainersInspectPayload) error {
	handle, err := s.getEndpoint(endpointID)
	if err != nil {
		return err
	}

	command := fmt.Sprintf(
		`%s inspect %s`,
		sshcmd.QuotePosix(handle.runtimeCommand),
		sshcmd.QuotePosix(payload.ContainerID),
	)
	stdout, err := s.runEndpointCommand(handle, command)
	if err != nil {
		return err
	}

	type inspectNetwork struct {
		IPAddress string   `json:"IPAddress"`
		Aliases   []string `json:"Aliases"`
	}
	type inspectMount struct {
		Type        string `json:"Type"`
		Source      string `json:"Source"`
		Destination string `json:"Destination"`
		Mode        string `json:"Mode"`
		RW          bool   `json:"RW"`
	}
	type inspectPortBinding struct {
		HostIP   string `json:"HostIp"`
		HostPort string `json:"HostPort"`
	}
	type inspectRecord struct {
		ID      string   `json:"Id"`
		Name    string   `json:"Name"`
		Created string   `json:"Created"`
		Path    string   `json:"Path"`
		Args    []string `json:"Args"`
		Config  struct {
			Image      string            `json:"Image"`
			Cmd        []string          `json:"Cmd"`
			Entrypoint []string          `json:"Entrypoint"`
			Env        []string          `json:"Env"`
			Labels     map[string]string `json:"Labels"`
			Exposed    map[string]any    `json:"ExposedPorts"`
		} `json:"Config"`
		State struct {
			Status string `json:"Status"`
		} `json:"State"`
		Mounts          []inspectMount `json:"Mounts"`
		NetworkSettings struct {
			Networks map[string]inspectNetwork       `json:"Networks"`
			Ports    map[string][]inspectPortBinding `json:"Ports"`
		} `json:"NetworkSettings"`
	}

	var records []inspectRecord
	if err := json.Unmarshal(stdout, &records); err != nil {
		return fmt.Errorf("failed to parse container details: %w", err)
	}
	if len(records) == 0 {
		return fmt.Errorf("container %s not found", payload.ContainerID)
	}
	record := records[0]

	mounts := make([]protocol.ContainerMountSummary, 0, len(record.Mounts))
	for _, mount := range record.Mounts {
		mounts = append(mounts, protocol.ContainerMountSummary{
			Type:        mount.Type,
			Source:      mount.Source,
			Destination: mount.Destination,
			Mode:        mount.Mode,
			ReadOnly:    !mount.RW,
		})
	}

	networkNames := make([]string, 0, len(record.NetworkSettings.Networks))
	for name := range record.NetworkSettings.Networks {
		networkNames = append(networkNames, name)
	}
	sort.Strings(networkNames)
	networks := make([]protocol.ContainerNetworkSummary, 0, len(networkNames))
	for _, name := range networkNames {
		network := record.NetworkSettings.Networks[name]
		networks = append(networks, protocol.ContainerNetworkSummary{
			Name:      name,
			IPAddress: network.IPAddress,
			Aliases:   filterEmptyStrings(network.Aliases),
		})
	}

	portMap := make(map[string]protocol.ContainerPortSummary)
	for portSpec := range record.Config.Exposed {
		containerPort, protocolName, ok := parseContainerPortSpec(portSpec)
		if !ok {
			continue
		}
		portMap[portSpec] = protocol.ContainerPortSummary{
			ContainerPort:     containerPort,
			Protocol:          protocolName,
			PublishedBindings: []protocol.ContainerPortBinding{},
		}
	}
	for portSpec, bindings := range record.NetworkSettings.Ports {
		containerPort, protocolName, ok := parseContainerPortSpec(portSpec)
		if !ok {
			continue
		}
		summary := portMap[portSpec]
		summary.ContainerPort = containerPort
		summary.Protocol = protocolName
		summary.PublishedBindings = make([]protocol.ContainerPortBinding, 0, len(bindings))
		for _, binding := range bindings {
			var hostPort int
			if binding.HostPort != "" {
				parsedHostPort, parseErr := strconv.Atoi(binding.HostPort)
				if parseErr == nil {
					hostPort = parsedHostPort
				}
			}
			summary.PublishedBindings = append(summary.PublishedBindings, protocol.ContainerPortBinding{
				HostIP:   binding.HostIP,
				HostPort: hostPort,
			})
		}
		portMap[portSpec] = summary
	}
	portKeys := make([]string, 0, len(portMap))
	for key := range portMap {
		portKeys = append(portKeys, key)
	}
	sort.Slice(portKeys, func(i, j int) bool {
		left := portMap[portKeys[i]]
		right := portMap[portKeys[j]]
		if left.ContainerPort != right.ContainerPort {
			return left.ContainerPort < right.ContainerPort
		}
		return left.Protocol < right.Protocol
	})
	ports := make([]protocol.ContainerPortSummary, 0, len(portKeys))
	for _, key := range portKeys {
		ports = append(ports, portMap[key])
	}

	environment := make([]protocol.KeyValuePair, 0, len(record.Config.Env))
	for _, entry := range record.Config.Env {
		key, value := splitKeyValue(entry)
		environment = append(environment, protocol.KeyValuePair{Key: key, Value: value})
	}
	sort.Slice(environment, func(i, j int) bool {
		return environment[i].Key < environment[j].Key
	})

	labels := make([]protocol.KeyValuePair, 0, len(record.Config.Labels))
	for key, value := range record.Config.Labels {
		labels = append(labels, protocol.KeyValuePair{Key: key, Value: value})
	}
	sort.Slice(labels, func(i, j int) bool {
		return labels[i].Key < labels[j].Key
	})

	commandText := strings.TrimSpace(
		strings.Join(
			append(filterEmptyStrings([]string{record.Path}), filterEmptyStrings(record.Args)...),
			" ",
		),
	)
	if commandText == "" {
		commandText = strings.Join(filterEmptyStrings(record.Config.Cmd), " ")
	}

	s.emit(protocol.Event{
		Type:       protocol.EventContainersInspected,
		RequestID:  requestID,
		EndpointID: endpointID,
		Payload: protocol.ContainerDetailsPayload{
			ID:          record.ID,
			Name:        strings.TrimPrefix(record.Name, "/"),
			Runtime:     handle.runtime,
			Image:       record.Config.Image,
			Status:      record.State.Status,
			CreatedAt:   record.Created,
			Command:     commandText,
			Entrypoint:  strings.Join(filterEmptyStrings(record.Config.Entrypoint), " "),
			Mounts:      mounts,
			Networks:    networks,
			Ports:       ports,
			Environment: environment,
			Labels:      labels,
		},
	})
	return nil
}

func (s *Service) Logs(endpointID, requestID string, payload protocol.ContainersLogsPayload) error {
	handle, err := s.getEndpoint(endpointID)
	if err != nil {
		return err
	}

	stdout, err := s.runEndpointLogsCommand(handle, buildLogsCommand(
		handle.runtimeCommand,
		payload.ContainerID,
		payload.Tail,
		payload.FollowCursor,
	))
	if err != nil {
		return err
	}

	lines := splitOutputLines(string(stdout))
	cursor := ""
	for _, line := range lines {
		if timestamp := extractLogTimestamp(line); timestamp != "" {
			cursor = timestamp
		}
	}

	s.emit(protocol.Event{
		Type:       protocol.EventContainersLogs,
		RequestID:  requestID,
		EndpointID: endpointID,
		Payload: protocol.ContainersLogsResultPayload{
			Runtime:     handle.runtime,
			ContainerID: payload.ContainerID,
			Lines:       lines,
			Cursor:      cursor,
		},
	})
	return nil
}

func (s *Service) Start(endpointID, requestID string, payload protocol.ContainersActionPayload) error {
	return s.runContainerAction(endpointID, requestID, "start", payload.ContainerID)
}

func (s *Service) Stop(endpointID, requestID string, payload protocol.ContainersActionPayload) error {
	return s.runContainerAction(endpointID, requestID, "stop", payload.ContainerID)
}

func (s *Service) Restart(endpointID, requestID string, payload protocol.ContainersActionPayload) error {
	return s.runContainerAction(endpointID, requestID, "restart", payload.ContainerID)
}

func (s *Service) Remove(endpointID, requestID string, payload protocol.ContainersActionPayload) error {
	return s.runContainerAction(endpointID, requestID, "remove", payload.ContainerID)
}

func (s *Service) Stats(endpointID, requestID string, payload protocol.ContainersStatsPayload) error {
	handle, err := s.getEndpoint(endpointID)
	if err != nil {
		return err
	}

	command := buildStatsCommand(handle.runtimeCommand, payload.ContainerID)
	stdout, err := s.runEndpointCommand(handle, command)
	if err != nil {
		return err
	}

	lines := splitOutputLines(string(stdout))
	if len(lines) == 0 {
		return fmt.Errorf("컨테이너 %s stats 정보를 확인하지 못했습니다. 실행 중인지 확인해 주세요.", payload.ContainerID)
	}

	fields := strings.SplitN(lines[0], "\t", 5)
	if len(fields) != 5 {
		return fmt.Errorf("failed to parse container stats output: %s", lines[0])
	}

	memoryUsedBytes, memoryLimitBytes, err := parseUsagePair(fields[1])
	if err != nil {
		return fmt.Errorf("failed to parse memory usage: %w", err)
	}
	networkRxBytes, networkTxBytes, err := parseUsagePair(fields[3])
	if err != nil {
		return fmt.Errorf("failed to parse network io: %w", err)
	}
	blockReadBytes, blockWriteBytes, err := parseUsagePair(fields[4])
	if err != nil {
		return fmt.Errorf("failed to parse block io: %w", err)
	}

	s.emit(protocol.Event{
		Type:       protocol.EventContainersStats,
		RequestID:  requestID,
		EndpointID: endpointID,
		Payload: protocol.ContainersStatsPayloadResult{
			Runtime:          handle.runtime,
			ContainerID:      payload.ContainerID,
			RecordedAt:       time.Now().UTC().Format(time.RFC3339Nano),
			CPUPercent:       parsePercent(fields[0]),
			MemoryUsedBytes:  memoryUsedBytes,
			MemoryLimitBytes: memoryLimitBytes,
			MemoryPercent:    parsePercent(fields[2]),
			NetworkRxBytes:   networkRxBytes,
			NetworkTxBytes:   networkTxBytes,
			BlockReadBytes:   blockReadBytes,
			BlockWriteBytes:  blockWriteBytes,
		},
	})
	return nil
}

func (s *Service) SearchLogs(endpointID, requestID string, payload protocol.ContainersSearchLogsPayload) error {
	handle, err := s.getEndpoint(endpointID)
	if err != nil {
		return err
	}

	stdout, err := s.runEndpointShellCommand(
		handle,
		buildSearchLogsCommand(handle.runtimeCommand, payload.ContainerID, payload.Tail, payload.Query),
	)
	if err != nil {
		return err
	}

	lines := splitOutputLines(string(stdout))
	s.emit(protocol.Event{
		Type:       protocol.EventContainersLogsSearched,
		RequestID:  requestID,
		EndpointID: endpointID,
		Payload: protocol.ContainersSearchLogsResultPayload{
			Runtime:     handle.runtime,
			ContainerID: payload.ContainerID,
			Query:       payload.Query,
			Lines:       lines,
			MatchCount:  len(lines),
		},
	})
	return nil
}

func (s *Service) runContainerAction(endpointID, requestID, action, containerID string) error {
	handle, err := s.getEndpoint(endpointID)
	if err != nil {
		return err
	}

	if strings.TrimSpace(containerID) == "" {
		return fmt.Errorf("container id is required")
	}

	command := buildContainerActionCommand(handle.runtimeCommand, action, containerID)
	if _, err := s.runEndpointCommand(handle, command); err != nil {
		return err
	}

	s.emit(protocol.Event{
		Type:       protocol.EventContainersActionCompleted,
		RequestID:  requestID,
		EndpointID: endpointID,
		Payload: protocol.ContainersActionCompletedPayload{
			Runtime:     handle.runtime,
			Action:      action,
			ContainerID: containerID,
			Message:     fmt.Sprintf("%s completed", action),
		},
	})
	return nil
}

func detectLoginShell(client *ssh.Client) (string, error) {
	output, err := runRemoteCommand(
		client,
		`sh -lc 'shell="${SHELL:-}"; if [ -z "$shell" ] && command -v getent >/dev/null 2>&1; then shell="$(getent passwd "$(id -un)" | cut -d: -f7)"; fi; if [ -z "$shell" ] && [ -r /etc/passwd ]; then shell="$(awk -F: -v u="$(id -un)" '"'"'$1==u {print $7; exit}'"'"' /etc/passwd)"; fi; printf %s "${shell:-/bin/sh}"'`,
	)
	if err != nil {
		return "", err
	}

	shell := strings.TrimSpace(string(output))
	if shell == "" {
		shell = "/bin/sh"
	}
	return shell, nil
}

func detectRuntime(client *ssh.Client, loginShell string) (runtime string, runtimeCommand string, unsupportedReason string, err error) {
	output, err := runRemoteCommand(
		client,
		buildAbsoluteRuntimeProbeCommand(),
	)
	if err != nil {
		return "", "", "", err
	}

	runtime, runtimeCommand, unsupportedReason, err = parseRuntimeProbeOutput(string(output))
	if err != nil || runtime != "" || unsupportedReason == "" {
		return runtime, runtimeCommand, unsupportedReason, err
	}

	shellOutput, shellErr := runRemoteCommand(
		client,
		wrapRuntimeProbeShellCommand(loginShell, buildShellFallbackRuntimeProbeCommand()),
	)
	if shellErr != nil {
		return "", "", buildUnsupportedRuntimeReason(
			loginShell,
			fmt.Sprintf("shell fallback failed: %v", shellErr),
		), nil
	}

	fallbackPayload := extractShellRuntimeProbePayload(string(shellOutput))
	runtime, runtimeCommand, _, err = parseRuntimeProbeOutput(fallbackPayload)
	if err != nil {
		return "", "", "", err
	}
	if runtime != "" {
		return runtime, runtimeCommand, "", nil
	}

	return "", "", buildUnsupportedRuntimeReason(
		loginShell,
		"shell fallback did not return docker/podman",
	), nil
}

func runRemoteCommand(client *ssh.Client, command string) ([]byte, error) {
	stdout, stderr, err := sshcmd.RunWithTimeout(client, command, 20*time.Second)
	if err != nil {
		stderrText := strings.TrimSpace(string(stderr))
		if stderrText != "" {
			return nil, fmt.Errorf("%w: %s", err, stderrText)
		}
		return nil, err
	}
	return stdout, nil
}

func (s *Service) runEndpointCommand(
	handle *endpointHandle,
	command string,
) ([]byte, error) {
	if handle.client == nil {
		return nil, fmt.Errorf("containers endpoint client is not connected")
	}
	stdout, err := runRemoteCommand(handle.client, command)
	if err != nil {
		return nil, fmt.Errorf(
			"%s 명령 실행에 실패했습니다. runtime=%s path=%s: %w",
			handle.runtime,
			handle.runtime,
			handle.runtimeCommand,
			err,
		)
	}
	return stdout, nil
}

func (s *Service) runEndpointLogsCommand(
	handle *endpointHandle,
	command string,
) ([]byte, error) {
	if handle.client == nil {
		return nil, fmt.Errorf("containers endpoint client is not connected")
	}
	stdout, stderr, err := sshcmd.RunWithTimeout(handle.client, command+" 2>&1", 20*time.Second)
	if err != nil {
		detail := strings.TrimSpace(string(stderr))
		if detail == "" {
			detail = strings.TrimSpace(string(stdout))
		}
		if detail != "" {
			return nil, fmt.Errorf(
				"%s logs 명령 실행에 실패했습니다. runtime=%s path=%s: %w: %s",
				handle.runtime,
				handle.runtime,
				handle.runtimeCommand,
				err,
				detail,
			)
		}
		return nil, fmt.Errorf(
			"%s logs 명령 실행에 실패했습니다. runtime=%s path=%s: %w",
			handle.runtime,
			handle.runtime,
			handle.runtimeCommand,
			err,
		)
	}
	return stdout, nil
}

func (s *Service) runEndpointShellCommand(
	handle *endpointHandle,
	command string,
) ([]byte, error) {
	if handle.client == nil {
		return nil, fmt.Errorf("containers endpoint client is not connected")
	}
	stdout, err := runRemoteCommand(
		handle.client,
		"sh -lc "+sshcmd.QuotePosix(command),
	)
	if err != nil {
		return nil, fmt.Errorf(
			"%s shell 명령 실행에 실패했습니다. runtime=%s path=%s: %w",
			handle.runtime,
			handle.runtime,
			handle.runtimeCommand,
			err,
		)
	}
	return stdout, nil
}

func closeEndpointClient(handle *endpointHandle) {
	if handle == nil || handle.client == nil {
		return
	}
	_ = handle.client.Close()
	handle.client = nil
}

func (s *Service) dialTarget(
	endpointID string,
	requestID string,
	target sshconn.Target,
) (*ssh.Client, error) {
	attempt := 0
	return sshconn.DialClient(target, sshconn.DefaultConfig, func(challenge sshconn.InteractiveChallenge) ([]string, error) {
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
}

func wrapRuntimeProbeShellCommand(loginShell string, command string) string {
	shell := strings.TrimSpace(loginShell)
	if shell == "" {
		shell = "/bin/sh"
	}
	base := strings.ToLower(filepath.Base(shell))
	switch base {
	case "bash", "zsh", "ksh", "mksh", "fish":
		return sshcmd.QuotePosix(shell) + " -ilc " + sshcmd.QuotePosix(command)
	default:
		return sshcmd.QuotePosix(shell) + " -lc " + sshcmd.QuotePosix(command)
	}
}

func buildAbsoluteRuntimeProbeCommand() string {
	var script strings.Builder
	script.WriteString(buildRuntimeProbeClause("docker", dockerRuntimeCandidatePaths))
	script.WriteString(buildRuntimeProbeClause("podman", podmanRuntimeCandidatePaths))
	script.WriteString(`printf "none"`)
	return script.String()
}

func buildShellFallbackRuntimeProbeCommand() string {
	var script strings.Builder
	script.WriteString(`printf "__DOLGATE_RUNTIME_PROBE_START__\n";`)
	script.WriteString(`docker_path="$(command -v docker 2>/dev/null || which docker 2>/dev/null || true)";`)
	script.WriteString(`if [ -n "$docker_path" ]; then printf "docker\t%s\n" "$docker_path"; printf "__DOLGATE_RUNTIME_PROBE_END__"; exit 0; fi;`)
	script.WriteString(`podman_path="$(command -v podman 2>/dev/null || which podman 2>/dev/null || true)";`)
	script.WriteString(`if [ -n "$podman_path" ]; then printf "podman\t%s\n" "$podman_path"; printf "__DOLGATE_RUNTIME_PROBE_END__"; exit 0; fi;`)
	script.WriteString(`printf "none\n__DOLGATE_RUNTIME_PROBE_END__"`)
	return script.String()
}

func buildRuntimeProbeClause(runtime string, candidates []string) string {
	var clause strings.Builder
	clause.WriteString("for candidate in")
	for _, candidate := range candidates {
		clause.WriteString(" ")
		clause.WriteString(sshcmd.QuotePosix(candidate))
	}
	clause.WriteString(`; do if [ -x "$candidate" ]; then printf "`)
	clause.WriteString(runtime)
	clause.WriteString(`\t%s" "$candidate"; exit 0; fi; done;`)
	return clause.String()
}

func parseRuntimeProbeOutput(output string) (runtime string, runtimeCommand string, unsupportedReason string, err error) {
	trimmed := strings.TrimSpace(output)
	parts := strings.SplitN(trimmed, "\t", 2)
	switch parts[0] {
	case "docker", "podman":
		if len(parts) < 2 || strings.TrimSpace(parts[1]) == "" {
			return "", "", "", fmt.Errorf("%s 경로를 확인하지 못했습니다", parts[0])
		}
		runtimeCommand = strings.TrimSpace(parts[1])
		if !strings.HasPrefix(runtimeCommand, "/") {
			return "", "", "", fmt.Errorf("%s 절대 경로를 확인하지 못했습니다: %s", parts[0], runtimeCommand)
		}
		return parts[0], runtimeCommand, "", nil
	default:
		return "", "", buildUnsupportedRuntimeReason(
			"",
			"absolute path probe did not return docker/podman",
		), nil
	}
}

func buildUnsupportedRuntimeReason(loginShell string, shellFallbackDetail string) string {
	return fmt.Sprintf(
		"이 host에서는 docker/podman을 감지하지 못했습니다. 시도한 절대 경로: %s. shell fallback(%s): %s",
		strings.Join(runtimeProbeDiagnostics(), ", "),
		strings.TrimSpace(loginShell),
		shellFallbackDetail,
	)
}

func runtimeProbeDiagnostics() []string {
	diagnostics := make([]string, 0, len(dockerRuntimeCandidatePaths)+len(podmanRuntimeCandidatePaths)+2)
	diagnostics = append(diagnostics, dockerRuntimeCandidatePaths...)
	diagnostics = append(diagnostics, podmanRuntimeCandidatePaths...)
	return diagnostics
}

func extractShellRuntimeProbePayload(output string) string {
	const startMarker = "__DOLGATE_RUNTIME_PROBE_START__"
	const endMarker = "__DOLGATE_RUNTIME_PROBE_END__"
	start := strings.Index(output, startMarker)
	end := strings.Index(output, endMarker)
	if start >= 0 && end > start {
		return strings.TrimSpace(output[start+len(startMarker) : end])
	}
	return strings.TrimSpace(output)
}

func buildLogsCommand(runtimeCommand string, containerID string, tail int, followCursor string) string {
	if tail <= 0 {
		tail = 200
	}

	var command strings.Builder
	command.WriteString(sshcmd.QuotePosix(runtimeCommand))
	command.WriteString(" logs --timestamps --tail ")
	command.WriteString(fmt.Sprintf("%d", tail))
	if strings.TrimSpace(followCursor) != "" {
		command.WriteString(" --since ")
		command.WriteString(sshcmd.QuotePosix(strings.TrimSpace(followCursor)))
	}
	command.WriteString(" ")
	command.WriteString(sshcmd.QuotePosix(containerID))
	return command.String()
}

func buildContainerActionCommand(runtimeCommand, action, containerID string) string {
	var command strings.Builder
	command.WriteString(sshcmd.QuotePosix(runtimeCommand))
	command.WriteString(" ")
	switch action {
	case "start":
		command.WriteString("start ")
	case "stop":
		command.WriteString("stop ")
	case "restart":
		command.WriteString("restart ")
	case "remove":
		command.WriteString("rm ")
	default:
		command.WriteString(action)
		command.WriteString(" ")
	}
	command.WriteString(sshcmd.QuotePosix(containerID))
	return command.String()
}

func buildStatsCommand(runtimeCommand string, containerID string) string {
	const statsFormat = "{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}\t{{.BlockIO}}"
	return fmt.Sprintf(
		`%s stats --no-stream --format %s %s`,
		sshcmd.QuotePosix(runtimeCommand),
		sshcmd.QuotePosix(statsFormat),
		sshcmd.QuotePosix(containerID),
	)
}

func buildSearchLogsCommand(runtimeCommand string, containerID string, tail int, query string) string {
	logsCommand := buildLogsCommand(runtimeCommand, containerID, tail, "")
	return fmt.Sprintf(
		`%s 2>&1 | LC_ALL=C grep -iF -- %s || true`,
		logsCommand,
		sshcmd.QuotePosix(query),
	)
}

func parsePercent(raw string) float64 {
	normalized := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(raw), "%"))
	if normalized == "" {
		return 0
	}
	value, err := strconv.ParseFloat(normalized, 64)
	if err != nil {
		return 0
	}
	return value
}

var sizeValuePattern = regexp.MustCompile(`^\s*([0-9]*\.?[0-9]+)\s*([A-Za-z]+)?\s*$`)

func parseUsagePair(raw string) (int64, int64, error) {
	parts := strings.SplitN(raw, "/", 2)
	if len(parts) != 2 {
		return 0, 0, fmt.Errorf("invalid usage pair: %s", raw)
	}
	left, err := parseByteSize(parts[0])
	if err != nil {
		return 0, 0, err
	}
	right, err := parseByteSize(parts[1])
	if err != nil {
		return 0, 0, err
	}
	return left, right, nil
}

func parseByteSize(raw string) (int64, error) {
	matches := sizeValuePattern.FindStringSubmatch(strings.TrimSpace(raw))
	if len(matches) == 0 {
		return 0, fmt.Errorf("invalid byte size: %s", raw)
	}
	value, err := strconv.ParseFloat(matches[1], 64)
	if err != nil {
		return 0, fmt.Errorf("invalid byte size value %q: %w", raw, err)
	}
	unit := strings.ToUpper(matches[2])
	multipliers := map[string]float64{
		"":   1,
		"B":  1,
		"KB": 1000, "KIB": 1024,
		"MB": 1000 * 1000, "MIB": 1024 * 1024,
		"GB": 1000 * 1000 * 1000, "GIB": 1024 * 1024 * 1024,
		"TB": 1000 * 1000 * 1000 * 1000, "TIB": 1024 * 1024 * 1024 * 1024,
		"PB": 1000 * 1000 * 1000 * 1000 * 1000, "PIB": 1024 * 1024 * 1024 * 1024 * 1024,
	}
	multiplier, ok := multipliers[unit]
	if !ok {
		return 0, fmt.Errorf("unsupported byte size unit %q", unit)
	}
	return int64(value * multiplier), nil
}

func splitOutputLines(output string) []string {
	trimmed := strings.TrimSpace(output)
	if trimmed == "" {
		return []string{}
	}
	rawLines := strings.Split(trimmed, "\n")
	lines := make([]string, 0, len(rawLines))
	for _, line := range rawLines {
		line = strings.TrimRight(line, "\r")
		if line == "" {
			continue
		}
		lines = append(lines, line)
	}
	return lines
}

func splitKeyValue(entry string) (string, string) {
	parts := strings.SplitN(entry, "=", 2)
	if len(parts) == 1 {
		return parts[0], ""
	}
	return parts[0], parts[1]
}

func parseContainerPortSpec(raw string) (int, string, bool) {
	parts := strings.SplitN(strings.TrimSpace(raw), "/", 2)
	if len(parts) != 2 {
		return 0, "", false
	}
	containerPort, err := strconv.Atoi(parts[0])
	if err != nil {
		return 0, "", false
	}
	protocolName := strings.ToLower(strings.TrimSpace(parts[1]))
	if protocolName == "" {
		return 0, "", false
	}
	return containerPort, protocolName, true
}

func filterEmptyStrings(values []string) []string {
	filtered := make([]string, 0, len(values))
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			filtered = append(filtered, value)
		}
	}
	return filtered
}

func extractLogTimestamp(line string) string {
	if line == "" {
		return ""
	}
	if index := strings.IndexByte(line, ' '); index > 0 {
		return line[:index]
	}
	return ""
}

func (s *Service) getEndpoint(endpointID string) (*endpointHandle, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	handle, ok := s.endpoints[endpointID]
	if !ok {
		return nil, fmt.Errorf("containers endpoint %s not found", endpointID)
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
	var matches []*pendingChallenge
	for challengeID, challenge := range s.pendingChallenges {
		if challenge.endpointID != endpointID {
			continue
		}
		matches = append(matches, challenge)
		delete(s.pendingChallenges, challengeID)
	}
	return matches
}
