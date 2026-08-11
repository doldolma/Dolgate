package ssmdatachannel

import (
	"bytes"
	"encoding/json"
	"testing"
)

// 이 파일이 잠그는 것: 공식 구현과 **바이트 단위로 같은** 규격인지.
//
// 여기서 어긋나면 붙기는 하고 화면만 깨진다(복호화 실패는 오류로 올리지만, 방향이 반대면 우리가
// 보낸 것도 에이전트가 못 읽는다). 그래서 방향·nonce 위치·키 분할을 각각 따로 확인한다.

// agentSide 는 에이전트가 쓰는 키 방향이다 — 클라이언트와 앞/뒤가 반대다
// (agent blockcipher.go: encryptionKey = plainTextKey[:32], decryptionKey = plainTextKey[32:]).
func agentSide(t *testing.T, plainTextKey []byte) *payloadCrypto {
	t.Helper()
	half := len(plainTextKey) / 2
	encrypt, err := newAEAD(plainTextKey[:half])
	if err != nil {
		t.Fatalf("agent encrypt key: %v", err)
	}
	decrypt, err := newAEAD(plainTextKey[half:])
	if err != nil {
		t.Fatalf("agent decrypt key: %v", err)
	}
	return &payloadCrypto{encrypt: encrypt, decrypt: decrypt}
}

func testKey() []byte {
	key := make([]byte, 64)
	for i := range key {
		key[i] = byte(i + 1)
	}
	return key
}

// 클라이언트가 봉한 것을 에이전트가 풀 수 있어야 한다. 키 절반의 방향이 이 테스트의 핵심이다 —
// 앞/뒤를 바꾸면 여기서만 깨진다.
func TestClientSealIsReadableByAgent(t *testing.T) {
	key := testKey()
	client, err := newPayloadCrypto(key)
	if err != nil {
		t.Fatalf("client crypto: %v", err)
	}
	agent := agentSide(t, key)

	sealed, err := client.seal([]byte("ls -al\r"))
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	plain, err := agent.open(sealed)
	if err != nil {
		t.Fatalf("에이전트가 클라이언트 암호문을 풀지 못했다(키 방향 확인): %v", err)
	}
	if string(plain) != "ls -al\r" {
		t.Errorf("plain = %q", plain)
	}
}

// 반대 방향도 같아야 한다.
func TestAgentSealIsReadableByClient(t *testing.T) {
	key := testKey()
	client, err := newPayloadCrypto(key)
	if err != nil {
		t.Fatalf("client crypto: %v", err)
	}
	agent := agentSide(t, key)

	sealed, err := agent.seal([]byte("PS C:\\> "))
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	plain, err := client.open(sealed)
	if err != nil {
		t.Fatalf("클라이언트가 에이전트 암호문을 풀지 못했다: %v", err)
	}
	if string(plain) != "PS C:\\> " {
		t.Errorf("plain = %q", plain)
	}
}

// nonce 는 암호문 **앞**에 붙고 12바이트다. 뒤에 붙이면 상대가 첫 12바이트를 nonce 로 읽어
// 조용히 실패한다.
func TestSealPutsNonceInFront(t *testing.T) {
	client, err := newPayloadCrypto(testKey())
	if err != nil {
		t.Fatalf("crypto: %v", err)
	}

	plain := []byte("hello")
	sealed, err := client.seal(plain)
	if err != nil {
		t.Fatalf("seal: %v", err)
	}

	// nonce(12) + 암호문(평문 길이) + GCM 태그(16)
	if want := encryptionNonceSize + len(plain) + 16; len(sealed) != want {
		t.Fatalf("len(sealed) = %d, want %d", len(sealed), want)
	}
	if bytes.Equal(sealed[:encryptionNonceSize], make([]byte, encryptionNonceSize)) {
		t.Error("nonce 자리가 0 이다 — 앞에 붙지 않았다")
	}
}

// 같은 키로 nonce 를 재사용하면 GCM 이 무너진다. 메시지마다 달라야 한다.
func TestSealUsesFreshNonce(t *testing.T) {
	client, err := newPayloadCrypto(testKey())
	if err != nil {
		t.Fatalf("crypto: %v", err)
	}

	first, err := client.seal([]byte("same"))
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	second, err := client.seal([]byte("same"))
	if err != nil {
		t.Fatalf("seal: %v", err)
	}

	if bytes.Equal(first[:encryptionNonceSize], second[:encryptionNonceSize]) {
		t.Error("nonce 가 같다")
	}
	if bytes.Equal(first, second) {
		t.Error("같은 평문이 같은 암호문이 됐다")
	}
}

// 짧은 payload·다른 키로 봉한 것은 오류여야 한다. 바이트를 그대로 흘려보내면 터미널에 깨진 문자만
// 쏟아지고 원인을 알 수 없다.
func TestOpenRejectsBadPayloads(t *testing.T) {
	client, err := newPayloadCrypto(testKey())
	if err != nil {
		t.Fatalf("crypto: %v", err)
	}

	if _, err := client.open([]byte("short")); err == nil {
		t.Error("nonce 도 안 되는 길이는 오류여야 한다")
	}

	other := make([]byte, 64)
	for i := range other {
		other[i] = byte(255 - i)
	}
	stranger, err := newPayloadCrypto(other)
	if err != nil {
		t.Fatalf("other crypto: %v", err)
	}
	sealed, err := stranger.seal([]byte("nope"))
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	if _, err := client.open(sealed); err == nil {
		t.Error("다른 키로 봉한 것은 오류여야 한다")
	}
}

// 홀수·빈 키는 절반으로 나눌 수 없다. GenerateDataKey 가 64바이트를 주는 것에 기대지만, 값이
// 어긋나면 여기서 멈춰야 한다.
func TestNewPayloadCryptoRejectsUnusableKeys(t *testing.T) {
	for _, key := range [][]byte{nil, {}, make([]byte, 33)} {
		if _, err := newPayloadCrypto(key); err == nil {
			t.Errorf("len=%d 는 거부해야 한다", len(key))
		}
	}
}

// 에이전트의 확인 문제: 풀어서 **다시 암호화해** 돌려줘야 한다. 그대로 돌려보내거나 평문으로
// 보내면 handshake 는 통과하고 그 직후 세션이 죽는다.
func TestAnswerEncryptionChallengeReEncrypts(t *testing.T) {
	key := testKey()
	client, err := newPayloadCrypto(key)
	if err != nil {
		t.Fatalf("crypto: %v", err)
	}
	agent := agentSide(t, key)

	challenge := []byte("random-challenge-value")
	sealed, err := agent.seal(challenge)
	if err != nil {
		t.Fatalf("agent seal: %v", err)
	}
	request, err := json.Marshal(EncryptionChallengeRequest{Challenge: sealed})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	answer, err := client.answerEncryptionChallenge(request)
	if err != nil {
		t.Fatalf("answer: %v", err)
	}

	var response EncryptionChallengeResponse
	if err := json.Unmarshal(answer, &response); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if bytes.Equal(response.Challenge, sealed) {
		t.Fatal("받은 암호문을 그대로 돌려줬다 — 다시 암호화해야 한다")
	}
	// 에이전트가 자기 복호화 키로 풀어 원래 값을 되찾을 수 있어야 한다.
	plain, err := agent.open(response.Challenge)
	if err != nil {
		t.Fatalf("에이전트가 우리 답을 풀지 못했다: %v", err)
	}
	if !bytes.Equal(plain, challenge) {
		t.Errorf("challenge = %q, want %q", plain, challenge)
	}
}
