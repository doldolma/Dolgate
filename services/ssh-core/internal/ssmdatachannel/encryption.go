package ssmdatachannel

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
)

// Session Manager 의 KMS 세션 암호화.
//
// **왜 TLS 위에 또 암호화하는가:** 웹소켓 TLS 는 AWS SSM 서비스에서 끊긴다. 즉 세션 바이트가 AWS
// 중계 구간에서는 평문이다. 세션 관리자 환경설정에서 KMS 암호화를 켜면 클라이언트와 에이전트가
// KMS 데이터 키로 종단간 암호화를 하고, 그때부터 AWS 서비스도 내용을 볼 수 없다.
//
// **켜져 있으면 강제다.** 에이전트가 handshake 에서 KMSEncryption 액션을 요청하고, 클라이언트가
// Success 로 답하지 못하면 에이전트가 세션을 취소한다("평문으로 하자" 협상은 없다).
//
// 규격은 공식 구현에서 확인했다(aws/session-manager-plugin src/encryption/encrypter.go,
// aws/amazon-ssm-agent agent/session/crypto/blockcipher.go):
//   - GenerateDataKey 로 64바이트를 받아 절반으로 나눈다
//   - **클라이언트는 앞 절반이 복호화(에이전트→우리), 뒤 절반이 암호화(우리→에이전트)** 다.
//     에이전트가 그 반대로 쓴다. 방향을 바꾸면 붙기는 하고 복호화만 조용히 깨진다
//   - AES-GCM, nonce 12바이트를 암호문 **앞에** 붙인다. AAD 는 쓰지 않는다
//   - 암·복호화 대상은 PayloadType == Output 인 스트림 데이터뿐이다. handshake·ack·크기 변경 등
//     제어 메시지는 평문으로 오간다
const encryptionNonceSize = 12

// SessionEncryption 은 이 세션에 쓸 KMS 데이터 키 자료다.
//
// 데이터 키를 만드는 것은 이 패키지가 아니라 호출부다. 이 패키지는 AWS 자격증명을 갖지 않는다는
// 규칙(doc.go 참고) 때문이다 — 세션 토큰과 같은 방식으로, 자격증명을 가진 쪽(데스크톱 메인)이
// kms:GenerateDataKey 를 부르고 그 결과만 넘겨준다.
type SessionEncryption struct {
	// KMSKeyID 는 데이터 키를 만들 때 쓴 키다. 에이전트가 handshake 로 요청한 키와 같은지
	// 대조한다 — 다르면 에이전트가 우리 blob 을 복호화할 수 없어 어차피 세션이 죽는다.
	KMSKeyID string
	// CipherTextBlob 은 KMS 가 준 암호문 키다. handshake 응답으로 에이전트에 넘기면 에이전트가
	// kms:Decrypt 로 같은 64바이트를 얻는다(그래서 인스턴스 역할에 kms:Decrypt 가 필요하다).
	CipherTextBlob []byte
	// PlainTextKey 는 64바이트 평문 키다. 이 프로세스 메모리에만 둔다.
	PlainTextKey []byte
}

// KMSEncryptionRequest 는 handshake 의 KMSEncryption 액션 파라미터다.
//
// 필드 이름은 에이전트 계약 그대로여야 한다(amazon-ssm-agent
// agent/session/contracts/model.go). 이름이 틀리면 에이전트가 빈 값으로 읽고 kms:Decrypt 가
// 실패해, 세션이 "closed" 로만 끊긴다 — 우리 쪽에는 아무 오류도 남지 않는다.
type KMSEncryptionRequest struct {
	KMSKeyID string `json:"KMSKeyId"`
	// Challenge 는 에이전트가 만든 무작위 문자열이다. 이 값을 처리하겠다고 답하면(아래
	// ChallengeAcknowledgement) 데이터 키의 EncryptionContext 에 이 값이 한 항목 더 들어간다.
	Challenge string `json:"Challenge"`
}

// KMSEncryptionResponse 는 그 액션의 결과로 에이전트에 돌려주는 값이다.
type KMSEncryptionResponse struct {
	// KMSCipherTextKey 다 — Blob 이 아니다. encoding/json 이 []byte 를 base64 문자열로 쓰는 것에
	// 기대는 것은 공식 구현과 같다.
	KMSCipherTextKey []byte `json:"KMSCipherTextKey"`
	// ChallengeAcknowledgement 는 "무작위 챌린지를 EncryptionContext 에 넣어 데이터 키를 만들었다"
	// 는 선언이다. 에이전트는 이 값으로 **자기 kms:Decrypt 의 EncryptionContext 를 정한다** —
	// 우리가 넣지 않았는데 true 로 답하거나 그 반대면 컨텍스트가 어긋나 복호화가 실패한다.
	//
	// 에이전트 설정에 RequireKMSChallengeResponse 가 켜져 있으면 false 는 아예 거부된다.
	ChallengeAcknowledgement bool `json:"ChallengeAcknowledgement"`
}

/** EncryptionContext 키 이름들. 에이전트와 한 글자도 달라선 안 된다. */
const (
	EncryptionContextSessionIDKey = "aws:ssm:SessionId"
	EncryptionContextTargetIDKey  = "aws:ssm:TargetId"
	// 무작위 챌린지를 쓰기로 한 경우에만 들어간다.
	EncryptionContextChallengeKey = "aws:ssm:RandomChallenge"
)

// EncryptionChallengeRequest 는 KMS 설정 직후 에이전트가 보내는 확인 문제다.
//
// 새 에이전트는 handshake 만으로 끝내지 않고, 자기가 암호화한 값을 우리가 풀어 다시 암호화해
// 돌려보내는지 확인한다. 이걸 처리하지 않으면 **handshake 는 통과하고 그 직후 세션이 죽는다.**
type EncryptionChallengeRequest struct {
	Challenge []byte `json:"Challenge"`
}

// EncryptionChallengeResponse 는 그 문제에 대한 답이다.
type EncryptionChallengeResponse struct {
	Challenge []byte `json:"Challenge"`
}

// payloadCrypto 는 한 세션의 양방향 AEAD 한 쌍이다.
type payloadCrypto struct {
	encrypt cipher.AEAD
	decrypt cipher.AEAD
}

// newPayloadCrypto 는 64바이트 평문 키를 방향별 AEAD 로 나눈다.
func newPayloadCrypto(plainTextKey []byte) (*payloadCrypto, error) {
	if len(plainTextKey) == 0 || len(plainTextKey)%2 != 0 {
		return nil, fmt.Errorf("ssm session key must be a non-empty even length, got %d bytes", len(plainTextKey))
	}
	half := len(plainTextKey) / 2
	// 앞 절반이 복호화, 뒤 절반이 암호화다. 에이전트가 정확히 반대로 쓴다.
	decrypt, err := newAEAD(plainTextKey[:half])
	if err != nil {
		return nil, err
	}
	encrypt, err := newAEAD(plainTextKey[half:])
	if err != nil {
		return nil, err
	}
	return &payloadCrypto{encrypt: encrypt, decrypt: decrypt}, nil
}

func newAEAD(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("ssm session cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("ssm session GCM: %w", err)
	}
	return aead, nil
}

// seal 은 nonce||암호문 을 만든다.
func (p *payloadCrypto) seal(plain []byte) ([]byte, error) {
	nonce := make([]byte, encryptionNonceSize)
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, fmt.Errorf("ssm session nonce: %w", err)
	}
	// Seal 의 dst 로 nonce 를 넘겨 nonce||암호문 한 덩어리로 만든다. nonce 는 메시지마다 새로
	// 만든다 — 같은 키로 nonce 를 재사용하면 GCM 이 무너진다.
	return p.encrypt.Seal(nonce, nonce, plain, nil), nil
}

// open 은 nonce||암호문 을 푼다.
func (p *payloadCrypto) open(sealed []byte) ([]byte, error) {
	if len(sealed) < encryptionNonceSize {
		return nil, fmt.Errorf("ssm session payload too short for a nonce: %d bytes", len(sealed))
	}
	plain, err := p.decrypt.Open(nil, sealed[:encryptionNonceSize], sealed[encryptionNonceSize:], nil)
	if err != nil {
		// 여기서 실패하면 키 방향이나 세션 설정이 어긋난 것이다 — 바이트를 그대로 흘려보내면
		// 터미널에 깨진 문자만 쏟아지고 원인을 알 수 없으므로 오류로 올린다.
		return nil, fmt.Errorf("ssm session decrypt: %w", err)
	}
	return plain, nil
}

// answerEncryptionChallenge 는 받은 문제를 풀어 다시 암호화한 답을 만든다.
func (p *payloadCrypto) answerEncryptionChallenge(payload []byte) ([]byte, error) {
	var request EncryptionChallengeRequest
	if err := json.Unmarshal(payload, &request); err != nil {
		return nil, fmt.Errorf("ssm encryption challenge: %w", err)
	}
	plain, err := p.open(request.Challenge)
	if err != nil {
		return nil, err
	}
	sealed, err := p.seal(plain)
	if err != nil {
		return nil, err
	}
	return json.Marshal(EncryptionChallengeResponse{Challenge: sealed})
}

// ssmDebugEnvVar 를 1 로 두면 세션 협상 진단을 stderr 로 남긴다.
//
// **기본은 꺼 둔다.** 데스크톱은 코어의 stderr 를 세션 오류 이벤트로 바꿔 화면에 띄우므로
// (core-manager 의 stderr 핸들러), 평소에 진단을 흘리면 정상 세션에도 오류 배너가 뜬다.
const ssmDebugEnvVar = "DOLGATE_SSM_DEBUG"

func ssmDebugEnabled() bool {
	return os.Getenv(ssmDebugEnvVar) == "1"
}

// debugLogf 는 진단이 켜져 있을 때만 남긴다.
func debugLogf(format string, args ...any) {
	if !ssmDebugEnabled() {
		return
	}
	log.Printf(format, args...)
}
