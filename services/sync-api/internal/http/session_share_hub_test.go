package http

import (
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestValidateViewerInputMessage(t *testing.T) {
	t.Run("accepts binary payloads with valid base64", func(t *testing.T) {
		message := viewerInputMessage{
			Type:     "input",
			Encoding: "binary",
			Data:     base64.StdEncoding.EncodeToString([]byte{0x1b, 0x5b, 0x41}),
		}

		if !validateViewerInputMessage(message) {
			t.Fatal("expected binary viewer input to be accepted")
		}
	})

	t.Run("rejects invalid base64 payloads", func(t *testing.T) {
		message := viewerInputMessage{
			Type:     "input",
			Encoding: "binary",
			Data:     "not-base64!!!",
		}

		if validateViewerInputMessage(message) {
			t.Fatal("expected invalid binary viewer input to be rejected")
		}
	})

	t.Run("accepts utf8 payloads", func(t *testing.T) {
		message := viewerInputMessage{
			Type:     "input",
			Encoding: "utf8",
			Data:     "한글",
		}

		if !validateViewerInputMessage(message) {
			t.Fatal("expected utf8 viewer input to be accepted")
		}
	})

	t.Run("rejects oversized payloads", func(t *testing.T) {
		message := viewerInputMessage{
			Type:     "input",
			Encoding: "utf8",
			Data:     strings.Repeat("a", maxViewerInputBytes+1),
		}

		if validateViewerInputMessage(message) {
			t.Fatal("expected oversized viewer input to be rejected")
		}
	})
}

func TestValidateViewerControlSignalMessage(t *testing.T) {
	t.Run("accepts supported control signals", func(t *testing.T) {
		message := viewerControlSignalMessage{
			Type:   "control-signal",
			Signal: "interrupt",
		}

		if !validateViewerControlSignalMessage(message) {
			t.Fatal("expected control signal to be accepted")
		}
	})

	t.Run("rejects unsupported control signals", func(t *testing.T) {
		message := viewerControlSignalMessage{
			Type:   "control-signal",
			Signal: "break",
		}

		if validateViewerControlSignalMessage(message) {
			t.Fatal("expected unsupported control signal to be rejected")
		}
	})
}

func TestSessionShareTransportValidation(t *testing.T) {
	if !isValidSessionShareTransport("") {
		t.Fatal("empty transport should default to ssh")
	}
	if !isValidSessionShareTransport("ssh") {
		t.Fatal("ssh transport should be valid")
	}
	if !isValidSessionShareTransport("aws-ssm") {
		t.Fatal("aws-ssm transport should be valid")
	}
	if normalizeSessionShareTransport("aws-ssm") != "aws-ssm" {
		t.Fatal("aws-ssm transport should be preserved")
	}
	if normalizeSessionShareTransport("invalid") != "ssh" {
		t.Fatal("unknown transport should fall back to ssh")
	}
}

func TestNormalizeSessionShareChatNickname(t *testing.T) {
	if nickname, ok := normalizeSessionShareChatNickname("  맑은 여우  "); !ok || nickname != "맑은 여우" {
		t.Fatalf("expected trimmed nickname, got %q / %v", nickname, ok)
	}
	if _, ok := normalizeSessionShareChatNickname(""); ok {
		t.Fatal("empty nickname should be rejected")
	}
	if _, ok := normalizeSessionShareChatNickname("한줄\n둘"); ok {
		t.Fatal("multiline nickname should be rejected")
	}
	if _, ok := normalizeSessionShareChatNickname(strings.Repeat("가", maxShareChatNicknameRunes+1)); ok {
		t.Fatal("oversized nickname should be rejected")
	}
}

func TestNormalizeSessionShareChatText(t *testing.T) {
	if text, ok := normalizeSessionShareChatText("  안녕하세요  "); !ok || text != "안녕하세요" {
		t.Fatalf("expected trimmed chat text, got %q / %v", text, ok)
	}
	if _, ok := normalizeSessionShareChatText(""); ok {
		t.Fatal("empty chat text should be rejected")
	}
	if text, ok := normalizeSessionShareChatText("한줄\n둘"); !ok || text != "한줄\n둘" {
		t.Fatalf("expected multiline chat text to be preserved, got %q / %v", text, ok)
	}
	if _, ok := normalizeSessionShareChatText(strings.Repeat("가", maxShareChatTextRunes+1)); ok {
		t.Fatal("oversized chat text should be rejected")
	}
}

func TestViewerChatMessageUpdatesHistoryAndIgnoresInputGate(t *testing.T) {
	hub := NewSessionShareHub()
	response := hub.Create("user-1", createSessionShareRequest{
		SessionID: "session-1",
		Title:     "Shared Session",
		Cols:      80,
		Rows:      24,
	}, "https://viewer.example.com")

	viewer := &shareConn{}
	hub.shares[response.ShareID].inputEnabled = false
	hub.shares[response.ShareID].viewers[viewer] = &sessionShareViewerState{}

	profilePayload, _ := json.Marshal(viewerChatProfileMessage{
		Type:     "chat-profile",
		Nickname: "맑은 여우",
	})
	if err := hub.handleViewerPayload(response.ShareID, viewer, profilePayload); err != nil {
		t.Fatalf("profile update failed: %v", err)
	}

	sendPayload, _ := json.Marshal(viewerChatSendMessage{
		Type: "chat-send",
		Text: "안녕하세요",
	})
	if err := hub.handleViewerPayload(response.ShareID, viewer, sendPayload); err != nil {
		t.Fatalf("chat send failed: %v", err)
	}

	share := hub.shares[response.ShareID]
	if len(share.chatLog) != 1 {
		t.Fatalf("expected 1 chat message, got %d", len(share.chatLog))
	}
	if share.chatLog[0].Nickname != "맑은 여우" || share.chatLog[0].Text != "안녕하세요" {
		t.Fatalf("unexpected chat payload: %#v", share.chatLog[0])
	}
}

func TestViewerChatHistoryCapsAtLatestEntriesAndUsesLatestNickname(t *testing.T) {
	hub := NewSessionShareHub()
	response := hub.Create("user-1", createSessionShareRequest{
		SessionID: "session-1",
		Title:     "Shared Session",
		Cols:      80,
		Rows:      24,
	}, "https://viewer.example.com")

	viewer := &shareConn{}
	hub.shares[response.ShareID].viewers[viewer] = &sessionShareViewerState{}

	for _, nickname := range []string{"첫 닉네임", "새 닉네임"} {
		payload, _ := json.Marshal(viewerChatProfileMessage{
			Type:     "chat-profile",
			Nickname: nickname,
		})
		if err := hub.handleViewerPayload(response.ShareID, viewer, payload); err != nil {
			t.Fatalf("profile update failed: %v", err)
		}
	}

	for index := 0; index < maxShareChatEntries+5; index += 1 {
		payload, _ := json.Marshal(viewerChatSendMessage{
			Type: "chat-send",
			Text: "메시지",
		})
		if err := hub.handleViewerPayload(response.ShareID, viewer, payload); err != nil {
			t.Fatalf("chat send failed at %d: %v", index, err)
		}
	}

	share := hub.shares[response.ShareID]
	if len(share.chatLog) != maxShareChatEntries {
		t.Fatalf("expected chat history cap %d, got %d", maxShareChatEntries, len(share.chatLog))
	}
	if share.chatLog[len(share.chatLog)-1].Nickname != "새 닉네임" {
		t.Fatalf("expected latest nickname on future messages, got %#v", share.chatLog[len(share.chatLog)-1])
	}
}

func TestDeleteByShareIDRemovesChatState(t *testing.T) {
	hub := NewSessionShareHub()
	response := hub.Create("user-1", createSessionShareRequest{
		SessionID: "session-1",
		Title:     "Shared Session",
		Cols:      80,
		Rows:      24,
	}, "https://viewer.example.com")

	viewer := &shareConn{}
	hub.shares[response.ShareID].viewers[viewer] = &sessionShareViewerState{nickname: "맑은 여우"}
	hub.shares[response.ShareID].chatLog = []sessionShareChatMessage{{
		ID:       "chat-1",
		Nickname: "맑은 여우",
		Text:     "안녕하세요",
		SentAt:   "2026-03-27T00:00:00Z",
	}}

	if err := hub.DeleteByShareID(response.ShareID, "세션 공유가 종료되었습니다."); err != nil {
		t.Fatalf("delete by share id failed: %v", err)
	}
	if _, ok := hub.shares[response.ShareID]; ok {
		t.Fatal("expected share to be removed entirely")
	}
}

func TestSessionShareOriginValidation(t *testing.T) {
	allowedRequest := httptest.NewRequest("GET", "https://viewer.example.com/share/abc/token/ws", nil)
	allowedRequest.Host = "viewer.example.com"
	allowedRequest.Header.Set("Origin", "https://viewer.example.com")
	if !isSessionShareOriginAllowed(allowedRequest) {
		t.Fatal("expected same-origin websocket request to be allowed")
	}

	rejectedRequest := httptest.NewRequest("GET", "https://viewer.example.com/share/abc/token/ws", nil)
	rejectedRequest.Host = "viewer.example.com"
	rejectedRequest.Header.Set("Origin", "https://evil.example.com")
	if isSessionShareOriginAllowed(rejectedRequest) {
		t.Fatal("expected mismatched origin to be rejected")
	}

	missingOriginRequest := httptest.NewRequest("GET", "https://viewer.example.com/share/abc/token/ws", nil)
	missingOriginRequest.Host = "viewer.example.com"
	if isSessionShareOriginAllowed(missingOriginRequest) {
		t.Fatal("expected missing origin to be rejected")
	}
}
