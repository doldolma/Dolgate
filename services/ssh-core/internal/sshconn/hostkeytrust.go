package sshconn

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"net"
	"strings"

	"golang.org/x/crypto/ssh"
)

// HostKeyTrustRequest 는 "이 서버 키를 신뢰하겠습니까" 를 묻기 위한 사실들이다.
//
// 화면이 지금 신뢰 대화상자에 그리는 값과 저장에 필요한 값을 모두 담는다 — 그래야 키를 미리 읽어
// 오는 별도 연결(프로브) 없이 이 연결 안에서 신뢰까지 끝낼 수 있다.
type HostKeyTrustRequest struct {
	// Hop 은 이 키를 내민 서버다. 점프 체인에서 누구의 키인지 이것으로 구분한다.
	Hop InteractiveHop
	// Algorithm 은 키 종류(ssh-ed25519 등)다.
	Algorithm string
	// FingerprintSHA256 은 사람이 대조하는 지문이다.
	FingerprintSHA256 string
	// PublicKeyBase64 는 저장할 키 자체다.
	PublicKeyBase64 string
	// Mismatch 는 이 호스트에 **이미 저장된 키가 있는데 다른 키가 왔다** 는 뜻이다.
	//
	// 판정은 코어가 하고 문구·확인 절차는 화면이 정한다(기존 동작 그대로: 새 키는 "신뢰",
	// 바뀐 키는 "교체" 로 다르게 묻는다). 여기서 임의로 끊지 않는 이유는 서버를 새로 설치한 경우가
	// 실제로 흔하고, 그때 사용자가 지문을 대조해 교체할 길이 있어야 하기 때문이다.
	Mismatch bool
}

// HostKeyTrustFunc 는 사람에게 물어 신뢰 여부를 받아 온다. 오류면 연결을 끊는다.
type HostKeyTrustFunc func(HostKeyTrustRequest) (bool, error)

// ErrHostKeyMismatch 는 저장된 키와 다른 키가 왔고, 물을 창구가 없을 때다.
//
// 문구를 유지하는 이유: 데스크톱이 이 문구로 "키가 바뀐 실패" 를 분류해 복구 화면을 띄운다
// (shared-core 의 getConnectionFailureReason).
var ErrHostKeyMismatch = fmt.Errorf("host key mismatch")

// ErrHostKeyUnknown 는 저장된 키가 없고 물을 창구도 없을 때다(프로브·호스트 편집 경로).
var ErrHostKeyUnknown = fmt.Errorf("trusted host key is required")

// hostKeyCallbackFor 는 신뢰 판정을 하는 ssh.HostKeyCallback 을 만든다.
//
//	저장된 키 있음 + 일치   → 통과
//	저장된 키 있음 + 불일치 → 창구 O: 교체할지 묻는다 / 창구 X: ErrHostKeyMismatch
//	저장된 키 없음          → 창구 O: 신뢰할지 묻는다 / 창구 X: ErrHostKeyUnknown
func hostKeyCallbackFor(
	target Target,
	trust HostKeyTrustFunc,
) (ssh.HostKeyCallback, error) {
	expectedKeys, err := decodeTrustedKeys(target.TrustedHostKeyBase64, target.TrustedHostKeysBase64)
	if err != nil {
		return nil, err
	}
	hop := hopOf(target)

	return func(_ string, _ net.Addr, key ssh.PublicKey) error {
		actual := key.Marshal()
		mismatch := false
		if len(expectedKeys) > 0 {
			for _, expected := range expectedKeys {
				if bytes.Equal(actual, expected) {
					return nil
				}
			}
			mismatch = true
		}

		if trust == nil {
			if mismatch {
				return ErrHostKeyMismatch
			}
			return ErrHostKeyUnknown
		}

		request := HostKeyTrustRequest{
			Hop:               hop,
			Algorithm:         key.Type(),
			FingerprintSHA256: ssh.FingerprintSHA256(key),
			PublicKeyBase64:   base64.StdEncoding.EncodeToString(actual),
			Mismatch:          mismatch,
		}
		AuthLogf(
			"%s: asking to trust %s %s (mismatch=%t)",
			describeHop(hop), request.Algorithm, request.FingerprintSHA256, mismatch,
		)
		accepted, err := trust(request)
		if err != nil {
			AuthLogf("%s: no trust answer came back: %v", describeHop(hop), err)
			return err
		}
		if !accepted {
			AuthLogf("%s: the user declined this host key", describeHop(hop))
			if mismatch {
				// 문구를 유지해 데스크톱의 "키가 바뀜" 분류가 그대로 동작하게 한다.
				return ErrHostKeyMismatch
			}
			return fmt.Errorf("host key was not trusted")
		}
		AuthLogf("%s: the user trusted this host key", describeHop(hop))
		return nil
	}, nil
}

// decodeTrustedKeys 는 설정에 담긴 신뢰 키들을 바이트로 푼다. 없으면 빈 목록이다(오류가 아니다).
func decodeTrustedKeys(single string, multiple []string) ([][]byte, error) {
	candidates := make([]string, 0, len(multiple)+1)
	for _, value := range multiple {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			candidates = append(candidates, trimmed)
		}
	}
	if len(candidates) == 0 {
		if trimmed := strings.TrimSpace(single); trimmed != "" {
			candidates = append(candidates, trimmed)
		}
	}

	expectedKeys := make([][]byte, 0, len(candidates))
	for _, candidate := range candidates {
		expected, err := base64.StdEncoding.DecodeString(candidate)
		if err != nil {
			return nil, fmt.Errorf("decode trusted host key: %w", err)
		}
		expectedKeys = append(expectedKeys, expected)
	}
	return expectedKeys, nil
}
