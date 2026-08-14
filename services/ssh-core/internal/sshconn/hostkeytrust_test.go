package sshconn

import (
	"encoding/base64"
	"fmt"
	"net"
	"testing"
)

// 신뢰 판정표를 고정한다. 이 표가 곧 보안선이다.
//
//	저장된 키 있음 + 일치   → 통과, 묻지 않는다
//	저장된 키 있음 + 불일치 → 창구 O: 교체할지 묻는다(기존 replace 흐름) / 창구 X: mismatch 오류
//	저장된 키 없음          → 창구 O: 신뢰할지 묻는다 / 창구 X: unknown 오류
func TestHostKeyTrustDecisions(t *testing.T) {
	storedSigner, _ := generateTestKeyPair(t)
	otherSigner, _ := generateTestKeyPair(t)
	stored := base64.StdEncoding.EncodeToString(storedSigner.PublicKey().Marshal())

	type asked struct {
		count    int
		mismatch bool
	}

	cases := []struct {
		name        string
		target      Target
		serverKey   string
		accept      bool
		trustExists bool
		wantAsked   asked
		wantErr     error
		wantFail    bool
	}{
		{
			name:        "저장된 키와 일치하면 묻지 않는다",
			target:      Target{Host: "h", Port: 22, Username: "u", TrustedHostKeyBase64: stored},
			serverKey:   "stored",
			trustExists: true,
			wantAsked:   asked{count: 0},
		},
		{
			name:        "저장된 키가 없으면 신뢰를 묻는다",
			target:      Target{Host: "h", Port: 22, Username: "u"},
			serverKey:   "stored",
			trustExists: true,
			accept:      true,
			wantAsked:   asked{count: 1, mismatch: false},
		},
		{
			name:        "저장된 키가 없고 거절하면 실패한다",
			target:      Target{Host: "h", Port: 22, Username: "u"},
			serverKey:   "stored",
			trustExists: true,
			accept:      false,
			wantAsked:   asked{count: 1, mismatch: false},
			wantFail:    true,
		},
		{
			name:        "키가 바뀌면 교체를 묻는다",
			target:      Target{Host: "h", Port: 22, Username: "u", TrustedHostKeyBase64: stored},
			serverKey:   "other",
			trustExists: true,
			accept:      true,
			wantAsked:   asked{count: 1, mismatch: true},
		},
		{
			name:        "키가 바뀌었고 거절하면 mismatch 로 실패한다",
			target:      Target{Host: "h", Port: 22, Username: "u", TrustedHostKeyBase64: stored},
			serverKey:   "other",
			trustExists: true,
			accept:      false,
			wantAsked:   asked{count: 1, mismatch: true},
			wantErr:     ErrHostKeyMismatch,
		},
		{
			name:      "창구가 없으면 모르는 키는 예전 오류다",
			target:    Target{Host: "h", Port: 22, Username: "u"},
			serverKey: "stored",
			wantErr:   ErrHostKeyUnknown,
		},
		{
			name:      "창구가 없으면 바뀐 키는 mismatch 오류다",
			target:    Target{Host: "h", Port: 22, Username: "u", TrustedHostKeyBase64: stored},
			serverKey: "other",
			wantErr:   ErrHostKeyMismatch,
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			seen := asked{}
			var trust HostKeyTrustFunc
			if testCase.trustExists {
				trust = func(request HostKeyTrustRequest) (bool, error) {
					seen.count += 1
					seen.mismatch = request.Mismatch
					if request.FingerprintSHA256 == "" || request.PublicKeyBase64 == "" {
						t.Errorf("지문·키가 비어 있다: %+v", request)
					}
					if request.Hop.Host != "h" || request.Hop.Port != 22 {
						t.Errorf("hop = %+v, want h:22", request.Hop)
					}
					return testCase.accept, nil
				}
			}

			callback, err := hostKeyCallbackFor(testCase.target, trust)
			if err != nil {
				t.Fatalf("hostKeyCallbackFor() error = %v", err)
			}

			key := storedSigner.PublicKey()
			if testCase.serverKey == "other" {
				key = otherSigner.PublicKey()
			}
			err = callback("h:22", &net.TCPAddr{}, key)

			if testCase.wantErr != nil {
				if err == nil || err.Error() != testCase.wantErr.Error() {
					t.Fatalf("error = %v, want %v", err, testCase.wantErr)
				}
			} else if testCase.wantFail {
				if err == nil {
					t.Fatal("거절했는데 통과했다")
				}
			} else if err != nil {
				t.Fatalf("error = %v, want nil", err)
			}

			if seen != testCase.wantAsked {
				t.Fatalf("물은 횟수·종류 = %+v, want %+v", seen, testCase.wantAsked)
			}
		})
	}
}

// 창구가 오류를 내면(사용자가 답하지 않고 연결을 끊는 등) 그 오류로 끝난다.
func TestHostKeyTrustPropagatesAskError(t *testing.T) {
	signer, _ := generateTestKeyPair(t)
	askError := fmt.Errorf("trust prompt was cancelled")

	callback, err := hostKeyCallbackFor(
		Target{Host: "h", Port: 22, Username: "u"},
		func(HostKeyTrustRequest) (bool, error) { return false, askError },
	)
	if err != nil {
		t.Fatalf("hostKeyCallbackFor() error = %v", err)
	}

	if err := callback("h:22", &net.TCPAddr{}, signer.PublicKey()); err == nil ||
		err.Error() != askError.Error() {
		t.Fatalf("error = %v, want %v", err, askError)
	}
}
