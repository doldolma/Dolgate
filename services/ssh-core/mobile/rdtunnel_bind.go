package mobile

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"

	"dolssh/services/ssh-core/internal/sshdial"
	"dolssh/services/ssh-core/pkg/coretypes"
)

// Remote Desktop tunnel gomobile surface.
//
// gomobile cannot carry interfaces or function values, so the binding exposes
// typed methods — one per transport — rather than a generic open-with-dialer.

// rdTunnelRequest is the wire form from JS.
type rdTunnelRequest struct {
	ID        string `json:"id"`
	Host      string `json:"host"`
	Port      int    `json:"port"`
	Transport string `json:"transport"` // "direct" | "tailscale" | "ssh" | "ssm"

	// --- Tailscale ---
	TailnetID   string `json:"tailnetId,omitempty"`
	TailnetName string `json:"tailnetName,omitempty"`

	// --- SSH tunnel ---
	coretypes.ConnectPayload `json:",inline"`
	// TargetHost/TargetPort is what the SSH server should forward to (the VNC
	// endpoint from the SSH server's perspective).
	TargetHost string `json:"targetHost,omitempty"`
	TargetPort int    `json:"targetPort,omitempty"`

	// --- Existing SSM port forward to wrap with loopback authentication ---
	LocalPort int `json:"localPort,omitempty"`
}

// rdTunnelResult is the JSON returned to JS.
type rdTunnelResult struct {
	TunnelID  string `json:"tunnelId"`
	Host      string `json:"host"`
	Port      int    `json:"port"`
	Transport string `json:"transport"`
	AuthToken string `json:"authToken,omitempty"`
}

// OpenRemoteDesktopTunnel is the single gomobile entry point. requestJSON is an
// rdTunnelRequest. Returns JSON rdTunnelResult.
func (e *Engine) OpenRemoteDesktopTunnel(requestJSON string) (string, error) {
	var req rdTunnelRequest
	if err := json.Unmarshal([]byte(requestJSON), &req); err != nil {
		return "", fmt.Errorf("parse rd tunnel request: %w", err)
	}
	if req.ID == "" {
		return "", errors.New("rdtunnel: id is required")
	}
	if req.Port <= 0 {
		return "", errors.New("rdtunnel: port is required")
	}

	switch req.Transport {
	case "direct", "":
		return e.openRDTunnelDirect(req)
	case "tailscale":
		return e.openRDTunnelTailscale(req)
	case "ssh":
		return e.openRDTunnelSSH(req)
	case "ssm":
		return e.openRDTunnelSSM(req)
	default:
		return "", fmt.Errorf("rdtunnel: unknown transport %q", req.Transport)
	}
}

// CloseRemoteDesktopTunnel closes a tunnel by ID.
func (e *Engine) CloseRemoteDesktopTunnel(tunnelID string) error {
	return e.CloseRDTunnel(tunnelID)
}

func (e *Engine) openRDTunnelDirect(req rdTunnelRequest) (string, error) {
	t, err := e.OpenRDTunnelDirect(req.ID, req.Host, req.Port)
	if err != nil {
		return "", err
	}
	return marshalTunnelResult(t, "direct")
}

func (e *Engine) openRDTunnelTailscale(req rdTunnelRequest) (string, error) {
	if req.TailnetID == "" {
		return "", errors.New("rdtunnel/tailscale: tailnetId is required")
	}
	dial, err := e.resolveTailnetDial(req.TailnetID, req.TailnetName)
	if err != nil {
		return "", fmt.Errorf("rdtunnel/tailscale: %w", err)
	}
	if dial == nil {
		return "", errors.New("rdtunnel/tailscale: tailnet runtime did not return a dialer")
	}

	dialer := &tailscaleRDDialer{
		dial: dial,
		host: req.Host,
		port: req.Port,
	}
	t, err := e.OpenRDTunnel(req.ID, RDTunnelTailscale, dialer)
	if err != nil {
		return "", err
	}
	return marshalTunnelResult(t, "tailscale")
}

func (e *Engine) openRDTunnelSSH(req rdTunnelRequest) (string, error) {
	if req.Host == "" {
		return "", errors.New("rdtunnel/ssh: host is required")
	}
	targetHost := req.TargetHost
	if targetHost == "" {
		targetHost = "localhost"
	}
	targetPort := req.TargetPort
	if targetPort <= 0 {
		targetPort = req.Port
	}

	// Keep the complete payload intact and let internal/sshdial resolve its
	// Tailnet route, host-key policy, authentication and jump chain exactly as a
	// normal mobile SSH connection does. Re-resolving part of that path here is
	// how new connection lifecycle features used to miss Remote Desktop.
	payload := req.ConnectPayload
	// rdTunnelRequest also has top-level Host/Port fields. encoding/json assigns
	// those explicit fields instead of the embedded ConnectPayload fields with
	// the same tags, so copy the gateway address back into the shared SSH payload.
	payload.Host = req.Host
	payload.Port = req.Port
	dialer := &sshRDDialer{
		engine:       e,
		connectionID: req.ID,
		payload:      payload,
		targetHost:   targetHost,
		targetPort:   targetPort,
	}
	t, err := e.OpenRDTunnel(req.ID, RDTunnelSSH, dialer)
	if err != nil {
		return "", err
	}
	return marshalTunnelResult(t, "ssh")
}

func (e *Engine) openRDTunnelSSM(req rdTunnelRequest) (string, error) {
	if req.LocalPort <= 0 || req.LocalPort > 65535 {
		return "", errors.New("rdtunnel/ssm: localPort must be between 1 and 65535")
	}
	dialer := &tcpRDDialer{
		address: net.JoinHostPort("127.0.0.1", fmt.Sprintf("%d", req.LocalPort)),
	}
	t, err := e.OpenRDTunnel(req.ID, RDTunnelSSM, dialer)
	if err != nil {
		return "", err
	}
	return marshalTunnelResult(t, "ssm")
}

func marshalTunnelResult(t *RDTunnel, transport string) (string, error) {
	result := rdTunnelResult{
		TunnelID:  t.ID(),
		Host:      t.Host(),
		Port:      int(t.Port()),
		Transport: transport,
		AuthToken: t.AuthToken(),
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return "", fmt.Errorf("rdtunnel: encode result: %w", err)
	}
	return string(encoded), nil
}

// --- Existing local TCP forward dialer (SSM wrapper) ---

type tcpRDDialer struct {
	address string
}

func (d *tcpRDDialer) DialTarget(ctx context.Context) (net.Conn, error) {
	var dialer net.Dialer
	return dialer.DialContext(ctx, "tcp", d.address)
}

// --- Tailscale dialer ---

type tailscaleRDDialer struct {
	dial func(ctx context.Context, network, addr string) (net.Conn, error)
	host string
	port int
}

func (d *tailscaleRDDialer) DialTarget(ctx context.Context) (net.Conn, error) {
	addr := net.JoinHostPort(d.host, fmt.Sprintf("%d", d.port))
	return d.dial(ctx, "tcp", addr)
}

// --- SSH tunnel dialer ---

type sshRDDialer struct {
	engine       *Engine
	connectionID string
	payload      coretypes.ConnectPayload
	targetHost   string
	targetPort   int
}

func (d *sshRDDialer) DialTarget(ctx context.Context) (net.Conn, error) {
	// Reuse the normal mobile SSH connection's in-flight registry and event
	// correlation. That gives this path the same host-key prompt, interactive
	// authentication, banners, hop progress and cancellation as a terminal.
	dialCtx, finish := d.engine.dialer.Begin(d.connectionID)
	defer finish()
	stopParentCancellation := context.AfterFunc(ctx, func() {
		d.engine.dialer.CancelInFlight(d.connectionID)
		d.engine.dialer.CancelChallenges(d.connectionID)
	})
	defer stopParentCancellation()

	correlationID := ""
	if d.engine.hasConnectionListener() {
		correlationID = d.connectionID
	}
	client, _, err := d.engine.dialer.Dial(dialCtx, sshdial.Request{
		SessionID: correlationID,
		RequestID: correlationID,
		Payload:   d.payload,
	})
	if err != nil {
		return nil, fmt.Errorf("rdtunnel/ssh: dial ssh: %w", err)
	}
	// Open a direct-tcpip channel to the VNC/RDP endpoint.
	addr := net.JoinHostPort(d.targetHost, fmt.Sprintf("%d", d.targetPort))
	conn, err := client.Dial("tcp", addr)
	if err != nil {
		_ = client.Close()
		return nil, fmt.Errorf("rdtunnel/ssh: forward to %s: %w", addr, err)
	}
	// The SSH client stays alive as long as conn is open. When the bridge closes
	// conn, the underlying SSH channel EOF's and the client is collected.
	return &sshForwardConn{Conn: conn, client: client}, nil
}

// sshForwardConn wraps the forwarded net.Conn and closes the SSH client when
// the forwarded connection is closed.
type sshForwardConn struct {
	net.Conn
	client interface{ Close() error }
}

func (c *sshForwardConn) Close() error {
	connErr := c.Conn.Close()
	clientErr := c.client.Close()
	if connErr != nil {
		return connErr
	}
	return clientErr
}
