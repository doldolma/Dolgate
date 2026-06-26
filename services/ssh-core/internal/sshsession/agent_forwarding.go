package sshsession

import (
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"

	"dolssh/services/ssh-core/internal/protocol"
)

const (
	agentForwardingStatusActive      = "active"
	agentForwardingStatusUnavailable = "unavailable"
	agentForwardingStatusDenied      = "denied"
	agentForwardingStatusUnsupported = "unsupported"
	agentForwardingStatusUnknown     = "unknown"

	agentForwardingChannelType = "auth-agent@openssh.com"
)

func (m *Manager) setupAgentForwarding(
	sessionID string,
	requestID string,
	client *ssh.Client,
	session *ssh.Session,
	payload protocol.ConnectPayload,
) {
	if !payload.AgentForwarding {
		return
	}

	endpoint := strings.TrimSpace(payload.AgentForwardingEndpoint)
	if endpoint == "" {
		m.emitAgentForwardingStatus(
			sessionID,
			requestID,
			agentForwardingStatusUnavailable,
			"로컬 SSH agent endpoint를 찾지 못했습니다.",
			"agent-endpoint-missing",
		)
		return
	}

	if err := forwardAgentToEndpoint(client, payload.AgentForwardingEndpointKind, endpoint); err != nil {
		status := agentForwardingStatusUnavailable
		reason := "agent-connect-failed"
		if errors.Is(err, errAgentForwardingUnsupported) {
			status = agentForwardingStatusUnsupported
			reason = "agent-endpoint-unsupported"
		}
		m.emitAgentForwardingStatus(
			sessionID,
			requestID,
			status,
			err.Error(),
			reason,
		)
		return
	}

	if err := agent.RequestAgentForwarding(session); err != nil {
		status := agentForwardingStatusUnknown
		reason := "agent-forwarding-request-failed"
		if strings.Contains(strings.ToLower(err.Error()), "denied") {
			status = agentForwardingStatusDenied
			reason = "server-denied"
		}
		m.emitAgentForwardingStatus(
			sessionID,
			requestID,
			status,
			err.Error(),
			reason,
		)
		return
	}

	m.emitAgentForwardingStatus(
		sessionID,
		requestID,
		agentForwardingStatusActive,
		"SSH agent forwarding is active.",
		"agent-forwarding-active",
	)
}

func (m *Manager) emitAgentForwardingStatus(sessionID, requestID, status, message, reason string) {
	m.emit(protocol.Event{
		Type:      protocol.EventAgentForwardingStatus,
		RequestID: requestID,
		SessionID: sessionID,
		Payload: protocol.AgentForwardingStatusPayload{
			Status:  status,
			Message: message,
			Reason:  reason,
		},
	})
}

var errAgentForwardingUnsupported = fmt.Errorf("unsupported SSH agent endpoint")
