package http

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"

	"dolssh/services/ssh-core/pkg/coretypes"
	coreruntime "dolssh/services/ssh-core/pkg/runtime"
)

const (
	// awsSshTunnelSetupTimeout bounds the server-side setup (SSM StartSession +
	// data channel + EIC push + first tunnel dial) before we give up and report
	// an error frame to the desktop.
	awsSshTunnelSetupTimeout = 30 * time.Second
	awsSshTunnelWriteTimeout = 10 * time.Second
	// awsSshTunnelReadTimeout must exceed the desktop's SSH keepalive cadence (10s)
	// with margin; the WS carries that keepalive traffic plus our own pings.
	awsSshTunnelReadTimeout  = 45 * time.Second
	awsSshTunnelPingInterval = 15 * time.Second
	awsSshTunnelRelayBufSize = 32 * 1024
)

// AwsSshTunnelRelay turns sync-api into a bastion for the raw SSH transport: it
// opens the SSM port-forward to the instance on the server's (allowlisted) IP,
// pushes the desktop's ephemeral EIC key, and relays raw TCP over a WebSocket.
// The desktop's ssh-core speaks plain SSH over that WebSocket, so shell, tmux,
// sftp and forwarding all work through the server unchanged (server-proxy mode
// for IP-restricted VPCs). This is the server side of sshconn's WSProxy transport.
type AwsSshTunnelRelay struct {
	runtime   AwsSsmRuntime
	core      awsSftpCoreRuntime
	ssmTokens awsSsmTokenIssuer
	eic       awsEc2InstanceConnectAPI
	upgrader  websocket.Upgrader
}

func NewAwsSshTunnelRelay(runtime AwsSsmRuntime) *AwsSshTunnelRelay {
	relay := &AwsSshTunnelRelay{
		runtime:   runtime,
		ssmTokens: sdkAwsSsmTokenIssuer{},
		eic:       sdkAwsEc2InstanceConnect{},
		upgrader: websocket.Upgrader{
			CheckOrigin: func(_ *http.Request) bool { return true },
		},
	}
	relay.core = coreruntime.New(coreruntime.Options{})
	return relay
}

func (relay *AwsSshTunnelRelay) Close() {
	if relay.core != nil {
		relay.core.Shutdown()
	}
}

// awsSshTunnelStartMessage is the opaque JSON blob ssh-core forwards verbatim as
// the first WebSocket frame. It carries what the server needs to stand up the
// tunnel on the desktop's behalf; the desktop keeps the matching private key and
// performs the SSH handshake itself over the relayed bytes.
type awsSshTunnelStartMessage struct {
	Region           string            `json:"region"`
	ProfileName      string            `json:"profileName"`
	InstanceID       string            `json:"instanceId"`
	AvailabilityZone string            `json:"availabilityZone"`
	SSHUsername      string            `json:"sshUsername"`
	SSHPort          int               `json:"sshPort"`
	PublicKey        string            `json:"publicKey"`
	Env              map[string]string `json:"env"`
	UnsetEnv         []string          `json:"unsetEnv,omitempty"`
}

type awsSshTunnelControlFrame struct {
	Type    string `json:"type"`
	Message string `json:"message,omitempty"`
}

func (relay *AwsSshTunnelRelay) HandleWebSocket(writer http.ResponseWriter, request *http.Request) error {
	if !relay.runtime.Enabled {
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusServiceUnavailable)
		return json.NewEncoder(writer).Encode(map[string]string{
			"error": "AWS SSM runtime is unavailable on this server.",
		})
	}

	conn, err := relay.upgrader.Upgrade(writer, request, nil)
	if err != nil {
		return err
	}
	socket := &lockedWebSocket{conn: conn}
	defer socket.Close()

	ctx, cancel := context.WithCancel(request.Context())
	defer cancel()

	// Read the opaque start frame under a bounded deadline.
	_ = conn.SetReadDeadline(time.Now().Add(awsSshTunnelSetupTimeout))
	_, payload, err := conn.ReadMessage()
	if err != nil {
		return nil
	}
	var start awsSshTunnelStartMessage
	if err := json.Unmarshal(payload, &start); err != nil {
		_ = socket.WriteJSON(awsSshTunnelControlFrame{Type: "error", Message: "invalid start message"}, awsSshTunnelWriteTimeout)
		return nil
	}
	if err := validateAwsSshTunnelStart(start); err != nil {
		_ = socket.WriteJSON(awsSshTunnelControlFrame{Type: "error", Message: err.Error()}, awsSshTunnelWriteTimeout)
		return nil
	}

	tunnelConn, cleanup, err := relay.openTunnel(ctx, start)
	if err != nil {
		_ = socket.WriteJSON(awsSshTunnelControlFrame{Type: "error", Message: err.Error()}, awsSshTunnelWriteTimeout)
		return nil
	}
	defer cleanup()

	// Setup done — the desktop can now run its SSH handshake over the relay.
	if err := socket.WriteJSON(awsSshTunnelControlFrame{Type: "ready"}, awsSshTunnelWriteTimeout); err != nil {
		return nil
	}

	relay.pump(ctx, cancel, socket, conn, tunnelConn)
	return nil
}

// openTunnel opens the SSM port-forward to the instance and pushes the EIC key,
// returning a raw TCP conn to the tunnel plus a cleanup that tears it all down.
func (relay *AwsSshTunnelRelay) openTunnel(ctx context.Context, start awsSshTunnelStartMessage) (net.Conn, func(), error) {
	bindPort, err := reserveLocalhostPort()
	if err != nil {
		return nil, nil, err
	}
	tunnelID := "aws-ssh-tunnel:" + uuid.NewString()

	// ssh-core's in-process forwarder is credential-free: issue the port-forwarding
	// StartSession token here with the desktop-provided credentials.
	token, err := relay.ssmTokens.IssuePortForwardSession(ctx, start.Region, start.Env, start.InstanceID, start.SSHPort, bindPort)
	if err != nil {
		return nil, nil, fmt.Errorf("start AWS SSM tunnel: %w", err)
	}
	if err := relay.core.StartSSMPortForward(tunnelID, uuid.NewString(), coretypes.SSMPortForwardStartPayload{
		Region:       start.Region,
		TargetType:   "instance",
		TargetID:     start.InstanceID,
		BindAddress:  "127.0.0.1",
		BindPort:     bindPort,
		TargetKind:   "instance-port",
		TargetPort:   start.SSHPort,
		Env:          start.Env,
		UnsetEnv:     start.UnsetEnv,
		StreamURL:    token.StreamURL,
		TokenValue:   token.TokenValue,
		SsmSessionID: token.SessionID,
	}); err != nil {
		return nil, nil, fmt.Errorf("start AWS SSM tunnel: %w", err)
	}
	stopTunnel := func() { _ = relay.core.StopSSMPortForward(tunnelID, uuid.NewString()) }

	// Push the desktop's ephemeral public key via EC2 Instance Connect from the
	// server's allowlisted IP. Reuse the SFTP request shape SendSSHPublicKey reads.
	eicRequest := awsSftpCreateSessionRequest{
		Region:           start.Region,
		InstanceID:       start.InstanceID,
		AvailabilityZone: start.AvailabilityZone,
		SSHUsername:      start.SSHUsername,
		Env:              start.Env,
	}
	if err := relay.eic.SendSSHPublicKey(ctx, eicRequest, start.PublicKey); err != nil {
		stopTunnel()
		return nil, nil, err
	}

	// Wait for the tunnel to accept a connection (data channel established), then
	// hand back that raw conn — it becomes the byte pipe the SSH session rides.
	tunnelConn, err := dialAwsSshTunnelWithRetry(ctx, "127.0.0.1", bindPort, awsSshTunnelSetupTimeout)
	if err != nil {
		stopTunnel()
		return nil, nil, err
	}
	cleanup := func() {
		_ = tunnelConn.Close()
		stopTunnel()
	}
	return tunnelConn, cleanup, nil
}

// pump relays raw bytes both ways until either side closes. It runs the WS→tunnel
// direction on the calling goroutine and tunnel→WS + keepalive pings on their own.
func (relay *AwsSshTunnelRelay) pump(ctx context.Context, cancel context.CancelFunc, socket *lockedWebSocket, conn *websocket.Conn, tunnelConn net.Conn) {
	var once sync.Once
	stop := func() {
		once.Do(func() {
			cancel()
			_ = tunnelConn.Close()
			_ = socket.Close()
		})
	}

	// Keepalive pings so idle NAT/proxies don't drop the tunnel.
	go func() {
		ticker := time.NewTicker(awsSshTunnelPingInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := socket.WriteControl(websocket.PingMessage, nil, awsSshTunnelWriteTimeout); err != nil {
					stop()
					return
				}
			}
		}
	}()

	// tunnel → WS
	go func() {
		defer stop()
		buf := make([]byte, awsSshTunnelRelayBufSize)
		for {
			n, readErr := tunnelConn.Read(buf)
			if n > 0 {
				if err := socket.WriteMessage(websocket.BinaryMessage, buf[:n], awsSshTunnelWriteTimeout); err != nil {
					return
				}
			}
			if readErr != nil {
				return
			}
		}
	}()

	// WS → tunnel (this goroutine). Pongs and inbound data both extend the deadline.
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(awsSshTunnelReadTimeout))
	})
	_ = conn.SetReadDeadline(time.Now().Add(awsSshTunnelReadTimeout))
	defer stop()
	for {
		messageType, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		_ = conn.SetReadDeadline(time.Now().Add(awsSshTunnelReadTimeout))
		if messageType != websocket.BinaryMessage && messageType != websocket.TextMessage {
			continue
		}
		if len(data) == 0 {
			continue
		}
		if _, err := tunnelConn.Write(data); err != nil {
			return
		}
	}
}

func validateAwsSshTunnelStart(start awsSshTunnelStartMessage) error {
	if strings.TrimSpace(start.Region) == "" {
		return errors.New("region is required")
	}
	if strings.TrimSpace(start.InstanceID) == "" {
		return errors.New("instanceId is required")
	}
	if strings.TrimSpace(start.AvailabilityZone) == "" {
		return errors.New("availabilityZone is required")
	}
	if strings.TrimSpace(start.SSHUsername) == "" {
		return errors.New("sshUsername is required")
	}
	if start.SSHPort <= 0 || start.SSHPort > 65535 {
		return errors.New("sshPort is invalid")
	}
	if strings.TrimSpace(start.PublicKey) == "" {
		return errors.New("publicKey is required")
	}
	if len(start.Env) == 0 {
		return errors.New("AWS credential env is required")
	}
	return nil
}

func dialAwsSshTunnelWithRetry(ctx context.Context, host string, port int, timeout time.Duration) (net.Conn, error) {
	deadline := time.Now().Add(timeout)
	dialer := &net.Dialer{Timeout: awsSftpConnectTimeout}
	var lastErr error
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}
		conn, err := dialer.DialContext(ctx, "tcp", fmt.Sprintf("%s:%d", host, port))
		if err == nil {
			return conn, nil
		}
		lastErr = err
		time.Sleep(100 * time.Millisecond)
	}
	if lastErr != nil {
		return nil, fmt.Errorf("dial SSM tunnel: %w", lastErr)
	}
	return nil, errors.New("dial SSM tunnel: timeout")
}

// WriteMessage serializes a data frame with the other lockedWebSocket writers
// (ping ticker, ready/error frames) so gorilla sees a single concurrent writer.
func (socket *lockedWebSocket) WriteMessage(messageType int, data []byte, timeout time.Duration) error {
	socket.mu.Lock()
	defer socket.mu.Unlock()
	if err := socket.conn.SetWriteDeadline(time.Now().Add(timeout)); err != nil {
		return err
	}
	return socket.conn.WriteMessage(messageType, data)
}
