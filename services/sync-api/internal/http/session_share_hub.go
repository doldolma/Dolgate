package http

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

const (
	maxShareReplayEntries     = 1024
	maxShareReplayBytes       = 1024 * 1024
	maxShareChatEntries       = 50
	maxShareChatNicknameRunes = 24
	maxShareChatTextRunes     = 300
	maxViewerInputBytes       = 64 * 1024
	sessionShareTransportSSH  = "ssh"
	sessionShareTransportAWS  = "aws-ssm"
)

type createSessionShareRequest struct {
	SessionID          string                 `json:"sessionId"`
	Title              string                 `json:"title"`
	HostLabel          string                 `json:"hostLabel"`
	Transport          string                 `json:"transport"`
	Cols               int                    `json:"cols"`
	Rows               int                    `json:"rows"`
	Snapshot           string                 `json:"snapshot"`
	TerminalAppearance sessionShareAppearance `json:"terminalAppearance"`
	ViewportPx         *sessionShareViewport  `json:"viewportPx"`
}

type createSessionShareResponse struct {
	ShareID    string `json:"shareId"`
	ViewerURL  string `json:"viewerUrl"`
	OwnerToken string `json:"ownerToken"`
}

type sessionShareAppearance struct {
	FontFamily    string  `json:"fontFamily"`
	FontSize      int     `json:"fontSize"`
	LineHeight    float64 `json:"lineHeight"`
	LetterSpacing int     `json:"letterSpacing"`
}

type sessionShareViewport struct {
	Width  int `json:"width"`
	Height int `json:"height"`
}

type ownerHelloMessage struct {
	Type               string                 `json:"type"`
	Title              string                 `json:"title"`
	HostLabel          string                 `json:"hostLabel"`
	Transport          string                 `json:"transport"`
	Cols               int                    `json:"cols"`
	Rows               int                    `json:"rows"`
	Snapshot           string                 `json:"snapshot"`
	TerminalAppearance sessionShareAppearance `json:"terminalAppearance"`
	ViewportPx         *sessionShareViewport  `json:"viewportPx"`
}

type ownerOutputMessage struct {
	Type string `json:"type"`
	Data string `json:"data"`
}

type ownerResizeMessage struct {
	Type               string                 `json:"type"`
	Cols               int                    `json:"cols"`
	Rows               int                    `json:"rows"`
	TerminalAppearance sessionShareAppearance `json:"terminalAppearance"`
	ViewportPx         *sessionShareViewport  `json:"viewportPx"`
}

type ownerSnapshotMessage struct {
	Type               string                 `json:"type"`
	Snapshot           string                 `json:"snapshot"`
	Cols               int                    `json:"cols"`
	Rows               int                    `json:"rows"`
	SnapshotKind       string                 `json:"snapshotKind"`
	TerminalAppearance sessionShareAppearance `json:"terminalAppearance"`
	ViewportPx         *sessionShareViewport  `json:"viewportPx"`
}

type ownerInputEnabledMessage struct {
	Type         string `json:"type"`
	InputEnabled bool   `json:"inputEnabled"`
}

type sessionShareChatMessage struct {
	ID       string `json:"id"`
	Nickname string `json:"nickname"`
	Text     string `json:"text"`
	SentAt   string `json:"sentAt"`
}

type ownerChatMessage struct {
	Type    string                  `json:"type"`
	Message sessionShareChatMessage `json:"message"`
}

type ownerSessionEndedMessage struct {
	Type string `json:"type"`
}

type viewerInputMessage struct {
	Type     string `json:"type"`
	Encoding string `json:"encoding"`
	Data     string `json:"data"`
}

func validateViewerInputMessage(message viewerInputMessage) bool {
	if message.Type != "input" || message.Data == "" {
		return false
	}

	switch message.Encoding {
	case "binary":
		payload, err := base64.StdEncoding.DecodeString(message.Data)
		return err == nil && len(payload) > 0 && len(payload) <= maxViewerInputBytes
	case "utf8":
		return utf8.ValidString(message.Data) && len(message.Data) <= maxViewerInputBytes
	default:
		return false
	}
}

type ownerViewerInputMessage struct {
	Type     string `json:"type"`
	Encoding string `json:"encoding"`
	Data     string `json:"data"`
}

type viewerControlSignalMessage struct {
	Type   string `json:"type"`
	Signal string `json:"signal"`
}

func validateViewerControlSignalMessage(message viewerControlSignalMessage) bool {
	return message.Type == "control-signal" && isValidSessionShareControlSignal(message.Signal)
}

type viewerChatProfileMessage struct {
	Type     string `json:"type"`
	Nickname string `json:"nickname"`
}

type viewerChatSendMessage struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

func normalizeSessionShareChatNickname(input string) (string, bool) {
	trimmed := strings.TrimSpace(input)
	if trimmed == "" || strings.ContainsAny(trimmed, "\r\n") {
		return "", false
	}
	if !utf8.ValidString(trimmed) || utf8.RuneCountInString(trimmed) > maxShareChatNicknameRunes {
		return "", false
	}
	return trimmed, true
}

func normalizeSessionShareChatText(input string) (string, bool) {
	normalized := strings.ReplaceAll(input, "\r\n", "\n")
	normalized = strings.ReplaceAll(normalized, "\r", "\n")
	trimmed := strings.TrimSpace(normalized)
	if trimmed == "" {
		return "", false
	}
	if !utf8.ValidString(trimmed) || utf8.RuneCountInString(trimmed) > maxShareChatTextRunes {
		return "", false
	}
	return trimmed, true
}

type ownerViewerControlSignalMessage struct {
	Type   string `json:"type"`
	Signal string `json:"signal"`
}

type ownerViewerCountMessage struct {
	Type        string `json:"type"`
	ViewerCount int    `json:"viewerCount"`
}

type ownerInputEnabledUpdate struct {
	Type         string `json:"type"`
	InputEnabled bool   `json:"inputEnabled"`
}

type ownerShareEndedMessage struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}

type viewerInitMessage struct {
	Type               string                 `json:"type"`
	Title              string                 `json:"title"`
	HostLabel          string                 `json:"hostLabel"`
	Transport          string                 `json:"transport"`
	Cols               int                    `json:"cols"`
	Rows               int                    `json:"rows"`
	InputEnabled       bool                   `json:"inputEnabled"`
	ViewerCount        int                    `json:"viewerCount"`
	TerminalAppearance sessionShareAppearance `json:"terminalAppearance"`
	ViewportPx         *sessionShareViewport  `json:"viewportPx"`
}

type viewerSnapshotInitMessage struct {
	Type               string                 `json:"type"`
	Snapshot           string                 `json:"snapshot"`
	TerminalAppearance sessionShareAppearance `json:"terminalAppearance"`
	ViewportPx         *sessionShareViewport  `json:"viewportPx"`
}

type viewerSnapshotResyncMessage struct {
	Type               string                 `json:"type"`
	Snapshot           string                 `json:"snapshot"`
	TerminalAppearance sessionShareAppearance `json:"terminalAppearance"`
	ViewportPx         *sessionShareViewport  `json:"viewportPx"`
}

type viewerReplayMessage struct {
	Type    string   `json:"type"`
	Entries []string `json:"entries"`
}

type viewerChatHistoryMessage struct {
	Type     string                    `json:"type"`
	Messages []sessionShareChatMessage `json:"messages"`
}

type viewerChatMessage struct {
	Type    string                  `json:"type"`
	Message sessionShareChatMessage `json:"message"`
}

type viewerOutputMessage struct {
	Type string `json:"type"`
	Data string `json:"data"`
}

type viewerResizeMessage struct {
	Type               string                 `json:"type"`
	Cols               int                    `json:"cols"`
	Rows               int                    `json:"rows"`
	TerminalAppearance sessionShareAppearance `json:"terminalAppearance"`
	ViewportPx         *sessionShareViewport  `json:"viewportPx"`
}

type viewerInputEnabledUpdate struct {
	Type         string `json:"type"`
	InputEnabled bool   `json:"inputEnabled"`
}

type viewerCountBroadcast struct {
	Type        string `json:"type"`
	ViewerCount int    `json:"viewerCount"`
}

type viewerShareEndedMessage struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}

type shareConn struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

func (c *shareConn) WriteJSON(payload any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.conn == nil {
		return nil
	}
	return c.conn.WriteJSON(payload)
}

func (c *shareConn) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.conn == nil {
		return nil
	}
	return c.conn.Close()
}

type sessionShareViewerState struct {
	nickname string
}

type sessionShare struct {
	id           string
	ownerUserID  string
	sessionID    string
	viewerToken  string
	ownerToken   string
	title        string
	hostLabel    string
	transport    string
	cols         int
	rows         int
	snapshot     string
	appearance   sessionShareAppearance
	viewportPx   *sessionShareViewport
	inputEnabled bool
	replayLog    []string
	replayBytes  int
	chatLog      []sessionShareChatMessage
	owner        *shareConn
	viewers      map[*shareConn]*sessionShareViewerState
}

type SessionShareHub struct {
	mu             sync.Mutex
	shares         map[string]*sessionShare
	ownerUpgrader  websocket.Upgrader
	viewerUpgrader websocket.Upgrader
}

func NewSessionShareHub() *SessionShareHub {
	return &SessionShareHub{
		shares: make(map[string]*sessionShare),
		ownerUpgrader: websocket.Upgrader{
			CheckOrigin: func(_ *http.Request) bool {
				return true
			},
		},
		viewerUpgrader: websocket.Upgrader{
			CheckOrigin: isSessionShareOriginAllowed,
		},
	}
}

func isSessionShareOriginAllowed(request *http.Request) bool {
	origin := strings.TrimSpace(request.Header.Get("Origin"))
	if origin == "" {
		return false
	}

	originURL, err := url.Parse(origin)
	if err != nil || originURL.Scheme == "" || originURL.Host == "" {
		return false
	}

	requestURL, err := url.Parse(requestBaseURL(request))
	if err != nil || requestURL.Scheme == "" || requestURL.Host == "" {
		return false
	}

	return strings.EqualFold(originURL.Scheme, requestURL.Scheme) && strings.EqualFold(originURL.Host, requestURL.Host)
}

func (hub *SessionShareHub) Create(ownerUserID string, input createSessionShareRequest, viewerBaseURL string) createSessionShareResponse {
	hub.mu.Lock()
	defer hub.mu.Unlock()

	shareID := uuid.NewString()
	viewerToken := uuid.NewString()
	ownerToken := uuid.NewString()
	hub.shares[shareID] = &sessionShare{
		id:           shareID,
		ownerUserID:  ownerUserID,
		sessionID:    input.SessionID,
		viewerToken:  viewerToken,
		ownerToken:   ownerToken,
		title:        input.Title,
		hostLabel:    input.HostLabel,
		transport:    normalizeSessionShareTransport(input.Transport),
		cols:         input.Cols,
		rows:         input.Rows,
		snapshot:     input.Snapshot,
		appearance:   input.TerminalAppearance,
		viewportPx:   input.ViewportPx,
		inputEnabled: false,
		viewers:      make(map[*shareConn]*sessionShareViewerState),
	}

	return createSessionShareResponse{
		ShareID:    shareID,
		ViewerURL:  viewerBaseURL + "/share/" + shareID + "/" + viewerToken,
		OwnerToken: ownerToken,
	}
}

func (hub *SessionShareHub) SetInputEnabled(ownerUserID, shareID string, inputEnabled bool) (bool, error) {
	hub.mu.Lock()
	share, ok := hub.shares[shareID]
	if !ok {
		hub.mu.Unlock()
		return false, errors.New("session share not found")
	}
	if share.ownerUserID != ownerUserID {
		hub.mu.Unlock()
		return false, errors.New("session share does not belong to the current user")
	}
	share.inputEnabled = inputEnabled
	owner := share.owner
	viewers := make([]*shareConn, 0, len(share.viewers))
	for viewer := range share.viewers {
		viewers = append(viewers, viewer)
	}
	hub.mu.Unlock()

	if owner != nil {
		_ = owner.WriteJSON(ownerInputEnabledUpdate{
			Type:         "input-enabled",
			InputEnabled: inputEnabled,
		})
	}
	for _, viewer := range viewers {
		_ = viewer.WriteJSON(viewerInputEnabledUpdate{
			Type:         "input-enabled",
			InputEnabled: inputEnabled,
		})
	}
	return true, nil
}

func (hub *SessionShareHub) Delete(ownerUserID, shareID string, message string) error {
	hub.mu.Lock()
	share, ok := hub.shares[shareID]
	if !ok {
		hub.mu.Unlock()
		return nil
	}
	if share.ownerUserID != ownerUserID {
		hub.mu.Unlock()
		return errors.New("session share does not belong to the current user")
	}
	delete(hub.shares, shareID)
	owner := share.owner
	viewers := make([]*shareConn, 0, len(share.viewers))
	for viewer := range share.viewers {
		viewers = append(viewers, viewer)
	}
	hub.mu.Unlock()

	if owner != nil {
		_ = owner.WriteJSON(ownerShareEndedMessage{
			Type:    "share-ended",
			Message: message,
		})
		_ = owner.Close()
	}
	for _, viewer := range viewers {
		_ = viewer.WriteJSON(viewerShareEndedMessage{
			Type:    "share-ended",
			Message: message,
		})
		_ = viewer.Close()
	}
	return nil
}

func (hub *SessionShareHub) HasViewerToken(shareID, viewerToken string) bool {
	hub.mu.Lock()
	defer hub.mu.Unlock()

	share, ok := hub.shares[shareID]
	return ok && share.viewerToken == viewerToken
}

func (hub *SessionShareHub) HasOwnerToken(shareID, ownerToken string) bool {
	hub.mu.Lock()
	defer hub.mu.Unlock()

	share, ok := hub.shares[shareID]
	return ok && share.ownerToken == ownerToken
}

func (hub *SessionShareHub) HandleOwnerWebSocket(writer http.ResponseWriter, request *http.Request, shareID, ownerToken string) error {
	conn, err := hub.ownerUpgrader.Upgrade(writer, request, nil)
	if err != nil {
		return err
	}

	shareConn := &shareConn{conn: conn}
	hub.mu.Lock()
	share, ok := hub.shares[shareID]
	if !ok || share.ownerToken != ownerToken {
		hub.mu.Unlock()
		_ = shareConn.Close()
		return errors.New("session share not found")
	}
	if share.owner != nil {
		_ = share.owner.Close()
	}
	share.owner = shareConn
	viewerCount := len(share.viewers)
	hub.mu.Unlock()

	_ = shareConn.WriteJSON(ownerViewerCountMessage{
		Type:        "viewer-count",
		ViewerCount: viewerCount,
	})
	_ = shareConn.WriteJSON(ownerInputEnabledUpdate{
		Type:         "input-enabled",
		InputEnabled: share.inputEnabled,
	})

	for {
		_, payload, err := conn.ReadMessage()
		if err != nil {
			break
		}
		if err := hub.handleOwnerPayload(shareID, payload); err != nil {
			break
		}
	}

	_ = hub.Delete(share.ownerUserID, shareID, "세션 공유가 종료되었습니다.")
	return nil
}

func (hub *SessionShareHub) HandleViewerWebSocket(writer http.ResponseWriter, request *http.Request, shareID, viewerToken string) error {
	conn, err := hub.viewerUpgrader.Upgrade(writer, request, nil)
	if err != nil {
		return err
	}

	viewer := &shareConn{conn: conn}
	var share *sessionShare
	hub.mu.Lock()
	share, ok := hub.shares[shareID]
	if !ok || share.viewerToken != viewerToken {
		hub.mu.Unlock()
		_ = viewer.Close()
		return errors.New("session share not found")
	}
	share.viewers[viewer] = &sessionShareViewerState{}
	initMessage := viewerInitMessage{
		Type:               "init",
		Title:              share.title,
		HostLabel:          share.hostLabel,
		Transport:          share.transport,
		Cols:               share.cols,
		Rows:               share.rows,
		InputEnabled:       share.inputEnabled,
		ViewerCount:        len(share.viewers),
		TerminalAppearance: share.appearance,
		ViewportPx:         share.viewportPx,
	}
	snapshot := share.snapshot
	replay := append([]string(nil), share.replayLog...)
	chatHistory := append([]sessionShareChatMessage(nil), share.chatLog...)
	owner := share.owner
	hub.mu.Unlock()

	_ = viewer.WriteJSON(initMessage)
	if snapshot != "" {
		_ = viewer.WriteJSON(viewerSnapshotInitMessage{
			Type:               "snapshot-init",
			Snapshot:           snapshot,
			TerminalAppearance: share.appearance,
			ViewportPx:         share.viewportPx,
		})
	}
	if len(replay) > 0 {
		_ = viewer.WriteJSON(viewerReplayMessage{
			Type:    "replay",
			Entries: replay,
		})
	}
	if len(chatHistory) > 0 {
		_ = viewer.WriteJSON(viewerChatHistoryMessage{
			Type:     "chat-history",
			Messages: chatHistory,
		})
	}
	hub.broadcastViewerCount(shareID)
	if owner != nil {
		_ = owner.WriteJSON(ownerViewerCountMessage{
			Type:        "viewer-count",
			ViewerCount: initMessage.ViewerCount,
		})
	}

	for {
		_, payload, err := conn.ReadMessage()
		if err != nil {
			break
		}
		if err := hub.handleViewerPayload(shareID, viewer, payload); err != nil {
			break
		}
	}

	hub.mu.Lock()
	share, ok = hub.shares[shareID]
	if ok {
		delete(share.viewers, viewer)
	}
	hub.mu.Unlock()
	_ = viewer.Close()
	hub.broadcastViewerCount(shareID)
	return nil
}

func (hub *SessionShareHub) handleOwnerPayload(shareID string, payload []byte) error {
	var envelope struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return err
	}

	switch envelope.Type {
	case "hello":
		var message ownerHelloMessage
		if err := json.Unmarshal(payload, &message); err != nil {
			return err
		}
		return hub.updateHello(shareID, message)
	case "output":
		var message ownerOutputMessage
		if err := json.Unmarshal(payload, &message); err != nil {
			return err
		}
		return hub.appendOutput(shareID, message.Data)
	case "resize":
		var message ownerResizeMessage
		if err := json.Unmarshal(payload, &message); err != nil {
			return err
		}
		return hub.updateResize(shareID, message.Cols, message.Rows, message.TerminalAppearance, message.ViewportPx)
	case "snapshot":
		var message ownerSnapshotMessage
		if err := json.Unmarshal(payload, &message); err != nil {
			return err
		}
		return hub.updateSnapshot(
			shareID,
			message.Snapshot,
			message.Cols,
			message.Rows,
			message.SnapshotKind,
			message.TerminalAppearance,
			message.ViewportPx,
		)
	case "input-enabled":
		var message ownerInputEnabledMessage
		if err := json.Unmarshal(payload, &message); err != nil {
			return err
		}
		_, err := hub.SetInputEnabledForOwnerMessage(shareID, message.InputEnabled)
		return err
	case "session-ended":
		var message ownerSessionEndedMessage
		if err := json.Unmarshal(payload, &message); err != nil {
			return err
		}
		_ = message
		return hub.DeleteByShareID(shareID, "세션 공유가 종료되었습니다.")
	default:
		return nil
	}
}

func (hub *SessionShareHub) handleViewerPayload(shareID string, viewer *shareConn, payload []byte) error {
	var envelope struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return err
	}

	switch envelope.Type {
	case "chat-profile":
		var message viewerChatProfileMessage
		if err := json.Unmarshal(payload, &message); err != nil {
			return err
		}
		nickname, ok := normalizeSessionShareChatNickname(message.Nickname)
		if !ok {
			return nil
		}
		return hub.updateViewerChatProfile(shareID, viewer, nickname)
	case "chat-send":
		var message viewerChatSendMessage
		if err := json.Unmarshal(payload, &message); err != nil {
			return err
		}
		text, ok := normalizeSessionShareChatText(message.Text)
		if !ok {
			return nil
		}
		return hub.broadcastViewerChatMessage(shareID, viewer, text)
	case "input":
		var message viewerInputMessage
		if err := json.Unmarshal(payload, &message); err != nil {
			return err
		}
		if !validateViewerInputMessage(message) {
			return nil
		}
		hub.mu.Lock()
		share, ok := hub.shares[shareID]
		if !ok {
			hub.mu.Unlock()
			return errors.New("session share not found")
		}
		owner := share.owner
		inputEnabled := share.inputEnabled
		hub.mu.Unlock()
		if !inputEnabled || owner == nil {
			return nil
		}
		return owner.WriteJSON(ownerViewerInputMessage{
			Type:     "viewer-input",
			Encoding: message.Encoding,
			Data:     message.Data,
		})
	case "control-signal":
		var message viewerControlSignalMessage
		if err := json.Unmarshal(payload, &message); err != nil {
			return err
		}
		if !validateViewerControlSignalMessage(message) {
			return nil
		}
		hub.mu.Lock()
		share, ok := hub.shares[shareID]
		if !ok {
			hub.mu.Unlock()
			return errors.New("session share not found")
		}
		owner := share.owner
		inputEnabled := share.inputEnabled
		hub.mu.Unlock()
		if !inputEnabled || owner == nil {
			return nil
		}
		return owner.WriteJSON(ownerViewerControlSignalMessage{
			Type:   "control-signal",
			Signal: message.Signal,
		})
	default:
		return nil
	}
}

func (hub *SessionShareHub) updateViewerChatProfile(shareID string, viewer *shareConn, nickname string) error {
	hub.mu.Lock()
	defer hub.mu.Unlock()

	share, ok := hub.shares[shareID]
	if !ok {
		return errors.New("session share not found")
	}
	viewerState, ok := share.viewers[viewer]
	if !ok {
		return errors.New("session share viewer not found")
	}
	viewerState.nickname = nickname
	return nil
}

func (hub *SessionShareHub) broadcastViewerChatMessage(shareID string, viewer *shareConn, text string) error {
	hub.mu.Lock()
	share, ok := hub.shares[shareID]
	if !ok {
		hub.mu.Unlock()
		return errors.New("session share not found")
	}
	viewerState, ok := share.viewers[viewer]
	if !ok {
		hub.mu.Unlock()
		return errors.New("session share viewer not found")
	}
	if viewerState.nickname == "" {
		hub.mu.Unlock()
		return nil
	}

	message := sessionShareChatMessage{
		ID:       uuid.NewString(),
		Nickname: viewerState.nickname,
		Text:     text,
		SentAt:   time.Now().UTC().Format(time.RFC3339),
	}
	share.chatLog = append(share.chatLog, message)
	for len(share.chatLog) > maxShareChatEntries {
		share.chatLog = share.chatLog[1:]
	}

	viewers := make([]*shareConn, 0, len(share.viewers))
	for viewerConn := range share.viewers {
		viewers = append(viewers, viewerConn)
	}
	owner := share.owner
	hub.mu.Unlock()

	payload := viewerChatMessage{
		Type:    "chat-message",
		Message: message,
	}
	for _, viewerConn := range viewers {
		_ = viewerConn.WriteJSON(payload)
	}
	if owner != nil {
		_ = owner.WriteJSON(ownerChatMessage{
			Type:    "chat-message",
			Message: message,
		})
	}
	return nil
}

func (hub *SessionShareHub) updateHello(shareID string, message ownerHelloMessage) error {
	hub.mu.Lock()
	share, ok := hub.shares[shareID]
	if !ok {
		hub.mu.Unlock()
		return errors.New("session share not found")
	}
	share.title = message.Title
	share.hostLabel = message.HostLabel
	share.transport = normalizeSessionShareTransport(message.Transport)
	share.cols = message.Cols
	share.rows = message.Rows
	share.snapshot = message.Snapshot
	share.appearance = message.TerminalAppearance
	share.viewportPx = message.ViewportPx
	share.replayLog = nil
	share.replayBytes = 0
	viewers := make([]*shareConn, 0, len(share.viewers))
	for viewer := range share.viewers {
		viewers = append(viewers, viewer)
	}
	initMessage := viewerInitMessage{
		Type:               "init",
		Title:              share.title,
		HostLabel:          share.hostLabel,
		Transport:          share.transport,
		Cols:               share.cols,
		Rows:               share.rows,
		InputEnabled:       share.inputEnabled,
		ViewerCount:        len(share.viewers),
		TerminalAppearance: share.appearance,
		ViewportPx:         share.viewportPx,
	}
	hub.mu.Unlock()

	for _, viewer := range viewers {
		_ = viewer.WriteJSON(initMessage)
		if share.snapshot != "" {
			_ = viewer.WriteJSON(viewerSnapshotResyncMessage{
				Type:               "snapshot-resync",
				Snapshot:           share.snapshot,
				TerminalAppearance: share.appearance,
				ViewportPx:         share.viewportPx,
			})
		}
	}
	return nil
}

func normalizeSessionShareTransport(transport string) string {
	if transport == sessionShareTransportAWS {
		return sessionShareTransportAWS
	}
	return sessionShareTransportSSH
}

func isValidSessionShareTransport(transport string) bool {
	switch transport {
	case "", sessionShareTransportSSH, sessionShareTransportAWS:
		return true
	default:
		return false
	}
}

func isValidSessionShareControlSignal(signal string) bool {
	switch signal {
	case "interrupt", "suspend", "quit":
		return true
	default:
		return false
	}
}

func (hub *SessionShareHub) appendOutput(shareID, data string) error {
	hub.mu.Lock()
	share, ok := hub.shares[shareID]
	if !ok {
		hub.mu.Unlock()
		return errors.New("session share not found")
	}
	share.replayLog = append(share.replayLog, data)
	share.replayBytes += len(data)
	for len(share.replayLog) > maxShareReplayEntries || share.replayBytes > maxShareReplayBytes {
		if len(share.replayLog) == 0 {
			break
		}
		removed := share.replayLog[0]
		share.replayLog = share.replayLog[1:]
		share.replayBytes -= len(removed)
	}
	viewers := make([]*shareConn, 0, len(share.viewers))
	for viewer := range share.viewers {
		viewers = append(viewers, viewer)
	}
	hub.mu.Unlock()

	for _, viewer := range viewers {
		_ = viewer.WriteJSON(viewerOutputMessage{
			Type: "output",
			Data: data,
		})
	}
	return nil
}

func (hub *SessionShareHub) updateResize(
	shareID string,
	cols, rows int,
	appearance sessionShareAppearance,
	viewportPx *sessionShareViewport,
) error {
	hub.mu.Lock()
	share, ok := hub.shares[shareID]
	if !ok {
		hub.mu.Unlock()
		return errors.New("session share not found")
	}
	share.cols = cols
	share.rows = rows
	share.appearance = appearance
	share.viewportPx = viewportPx
	viewers := make([]*shareConn, 0, len(share.viewers))
	for viewer := range share.viewers {
		viewers = append(viewers, viewer)
	}
	hub.mu.Unlock()

	for _, viewer := range viewers {
		_ = viewer.WriteJSON(viewerResizeMessage{
			Type:               "resize",
			Cols:               cols,
			Rows:               rows,
			TerminalAppearance: share.appearance,
			ViewportPx:         share.viewportPx,
		})
	}
	return nil
}

func (hub *SessionShareHub) updateSnapshot(
	shareID, snapshot string,
	cols, rows int,
	snapshotKind string,
	appearance sessionShareAppearance,
	viewportPx *sessionShareViewport,
) error {
	hub.mu.Lock()
	share, ok := hub.shares[shareID]
	if !ok {
		hub.mu.Unlock()
		return errors.New("session share not found")
	}
	share.snapshot = snapshot
	share.cols = cols
	share.rows = rows
	share.appearance = appearance
	share.viewportPx = viewportPx
	share.replayLog = nil
	share.replayBytes = 0
	viewers := make([]*shareConn, 0, len(share.viewers))
	for viewer := range share.viewers {
		viewers = append(viewers, viewer)
	}
	hub.mu.Unlock()

	if snapshotKind == "refresh" {
		return nil
	}

	for _, viewer := range viewers {
		_ = viewer.WriteJSON(viewerSnapshotResyncMessage{
			Type:               "snapshot-resync",
			Snapshot:           snapshot,
			TerminalAppearance: share.appearance,
			ViewportPx:         share.viewportPx,
		})
	}
	return nil
}

func (hub *SessionShareHub) SetInputEnabledForOwnerMessage(shareID string, inputEnabled bool) (bool, error) {
	hub.mu.Lock()
	share, ok := hub.shares[shareID]
	if !ok {
		hub.mu.Unlock()
		return false, errors.New("session share not found")
	}
	share.inputEnabled = inputEnabled
	viewers := make([]*shareConn, 0, len(share.viewers))
	for viewer := range share.viewers {
		viewers = append(viewers, viewer)
	}
	owner := share.owner
	hub.mu.Unlock()

	for _, viewer := range viewers {
		_ = viewer.WriteJSON(viewerInputEnabledUpdate{
			Type:         "input-enabled",
			InputEnabled: inputEnabled,
		})
	}
	if owner != nil {
		_ = owner.WriteJSON(ownerInputEnabledUpdate{
			Type:         "input-enabled",
			InputEnabled: inputEnabled,
		})
	}
	return true, nil
}

func (hub *SessionShareHub) DeleteByShareID(shareID, message string) error {
	hub.mu.Lock()
	share, ok := hub.shares[shareID]
	if !ok {
		hub.mu.Unlock()
		return nil
	}
	delete(hub.shares, shareID)
	owner := share.owner
	viewers := make([]*shareConn, 0, len(share.viewers))
	for viewer := range share.viewers {
		viewers = append(viewers, viewer)
	}
	hub.mu.Unlock()

	if owner != nil {
		_ = owner.WriteJSON(ownerShareEndedMessage{
			Type:    "share-ended",
			Message: message,
		})
		_ = owner.Close()
	}
	for _, viewer := range viewers {
		_ = viewer.WriteJSON(viewerShareEndedMessage{
			Type:    "share-ended",
			Message: message,
		})
		_ = viewer.Close()
	}
	return nil
}

func (hub *SessionShareHub) broadcastViewerCount(shareID string) {
	hub.mu.Lock()
	share, ok := hub.shares[shareID]
	if !ok {
		hub.mu.Unlock()
		return
	}
	viewerCount := len(share.viewers)
	viewers := make([]*shareConn, 0, len(share.viewers))
	for viewer := range share.viewers {
		viewers = append(viewers, viewer)
	}
	owner := share.owner
	hub.mu.Unlock()

	if owner != nil {
		_ = owner.WriteJSON(ownerViewerCountMessage{
			Type:        "viewer-count",
			ViewerCount: viewerCount,
		})
	}
	for _, viewer := range viewers {
		_ = viewer.WriteJSON(viewerCountBroadcast{
			Type:        "viewer-count",
			ViewerCount: viewerCount,
		})
	}
}
