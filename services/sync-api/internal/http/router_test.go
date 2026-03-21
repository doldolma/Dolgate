package http_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"keyterm/services/sync-api/internal/auth"
	httpserver "keyterm/services/sync-api/internal/http"
	"keyterm/services/sync-api/internal/store"
	syncmodel "keyterm/services/sync-api/internal/sync"
)

func TestAuthAndSyncFlow(t *testing.T) {
	gin.SetMode(gin.TestMode)

	sqliteStore, err := store.OpenSQLite("file:keyterm_sync_test?mode=memory&cache=shared")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	authService := auth.NewService(sqliteStore, "test-secret", 15*time.Minute, time.Hour)
	router := httpserver.NewRouter(sqliteStore, authService)

	signupBody := bytes.NewBufferString(`{"email":"user@example.com","password":"supersecure"}`)
	signupRequest := httptest.NewRequest(http.MethodPost, "/auth/signup", signupBody)
	signupRequest.Header.Set("Content-Type", "application/json")
	signupRecorder := httptest.NewRecorder()
	router.ServeHTTP(signupRecorder, signupRequest)
	if signupRecorder.Code != http.StatusCreated {
		t.Fatalf("expected signup to succeed, got %d: %s", signupRecorder.Code, signupRecorder.Body.String())
	}

	var signupResponse struct {
		UserID string `json:"userId"`
		Tokens struct {
			AccessToken  string `json:"accessToken"`
			RefreshToken string `json:"refreshToken"`
		} `json:"tokens"`
	}
	if err := json.Unmarshal(signupRecorder.Body.Bytes(), &signupResponse); err != nil {
		t.Fatalf("decode signup response: %v", err)
	}

	payload := syncmodel.Payload{
		Hosts: []syncmodel.Record{
			{
				ID:               "host-1",
				EncryptedPayload: "ciphertext-v1",
				UpdatedAt:        "2026-03-21T15:00:00Z",
			},
		},
	}
	payloadBytes, _ := json.Marshal(payload)

	postSync := httptest.NewRequest(http.MethodPost, "/sync", bytes.NewReader(payloadBytes))
	postSync.Header.Set("Authorization", "Bearer "+signupResponse.Tokens.AccessToken)
	postSync.Header.Set("Content-Type", "application/json")
	postSyncRecorder := httptest.NewRecorder()
	router.ServeHTTP(postSyncRecorder, postSync)
	if postSyncRecorder.Code != http.StatusAccepted {
		t.Fatalf("expected sync upsert to succeed, got %d: %s", postSyncRecorder.Code, postSyncRecorder.Body.String())
	}

	getSync := httptest.NewRequest(http.MethodGet, "/sync", nil)
	getSync.Header.Set("Authorization", "Bearer "+signupResponse.Tokens.AccessToken)
	getSyncRecorder := httptest.NewRecorder()
	router.ServeHTTP(getSyncRecorder, getSync)
	if getSyncRecorder.Code != http.StatusOK {
		t.Fatalf("expected sync fetch to succeed, got %d: %s", getSyncRecorder.Code, getSyncRecorder.Body.String())
	}

	var syncResponse syncmodel.Payload
	if err := json.Unmarshal(getSyncRecorder.Body.Bytes(), &syncResponse); err != nil {
		t.Fatalf("decode sync response: %v", err)
	}
	if len(syncResponse.Hosts) != 1 || syncResponse.Hosts[0].EncryptedPayload != "ciphertext-v1" {
		t.Fatalf("unexpected sync response: %#v", syncResponse)
	}
}

func TestSyncRequiresAuth(t *testing.T) {
	gin.SetMode(gin.TestMode)

	sqliteStore, err := store.OpenSQLite("file:keyterm_sync_auth_test?mode=memory&cache=shared")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	authService := auth.NewService(sqliteStore, "test-secret", 15*time.Minute, time.Hour)
	router := httpserver.NewRouter(sqliteStore, authService)

	request := httptest.NewRequest(http.MethodGet, "/sync", nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("expected unauthorized, got %d", recorder.Code)
	}
}
