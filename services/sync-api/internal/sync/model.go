package sync

import (
	"fmt"
	"strings"
)

type Kind string

// 서버가 아는 kind 목록은 없다.
//
// 저장소는 (user_id, kind, id) → 암호화 페이로드일 뿐이고, 서버는 내용을 볼 수 없다(E2EE).
// 그런데도 kind 를 열거해 두면 클라이언트가 동기화 항목을 하나 늘릴 때마다 서버를 고치고
// 배포해야 한다. 그 결합만 있고 얻는 것은 "오타 난 kind 가 저장됨"을 막는 정도라서, 열거
// 대신 형식 검사를 둔다.
//
// 아래 상수는 서버가 알아야 해서가 아니라 테스트와 로그에서 쓰기 위한 것이다.
const (
	KindGroups       Kind = "groups"
	KindHosts        Kind = "hosts"
	KindSecrets      Kind = "secrets"
	KindKnownHosts   Kind = "knownHosts"
	KindPortForwards Kind = "portForwards"
	KindDNSOverrides Kind = "dnsOverrides"
	KindPreferences  Kind = "preferences"
	KindAWSProfiles  Kind = "awsProfiles"
	KindSnippets     Kind = "snippets"
)

// MaxKindLength 는 kind 이름의 상한이다. 컬럼 정의(varchar(64))와 맞춘다.
const MaxKindLength = 64

// MaxKindsPerPush 는 한 번의 push 가 담을 수 있는 kind 수다. 열거를 없앤 대신 폭주를
// 막는 장치다 — 정상 클라이언트는 열 몇 개면 충분하다.
const MaxKindsPerPush = 64

// ValidateKind 는 kind 가 저장 가능한 형식인지 본다. 어떤 kind 인지는 묻지 않는다.
func ValidateKind(kind Kind) error {
	name := string(kind)
	if name == "" {
		return fmt.Errorf("sync kind is empty")
	}
	if len(name) > MaxKindLength {
		return fmt.Errorf("sync kind is too long: %d > %d", len(name), MaxKindLength)
	}
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
		default:
			return fmt.Errorf("invalid sync kind: %s", name)
		}
	}
	return nil
}

type Record struct {
	ID               string  `json:"id"`
	EncryptedPayload string  `json:"encrypted_payload"`
	UpdatedAt        string  `json:"updated_at"`
	DeletedAt        *string `json:"deleted_at,omitempty"`
}

// Payload 는 kind → 레코드다.
//
// 맵이지만 와이어 포맷은 명명된 필드였을 때와 같다 — {"hosts":[…],"snippets":[…]}. 그래서
// 구버전 클라이언트와 섞여도 문제가 없다. 모르는 kind 는 서로 무시할 뿐이고, push 는 upsert
// 라서 "안 보낸 kind" 가 지워지지도 않는다.
type Payload map[Kind][]Record

// Validate 는 push 로 들어온 페이로드의 kind 들을 검사한다.
func (p Payload) Validate() error {
	if len(p) > MaxKindsPerPush {
		return fmt.Errorf("too many sync kinds: %d > %d", len(p), MaxKindsPerPush)
	}
	for kind := range p {
		if err := ValidateKind(kind); err != nil {
			return err
		}
	}
	return nil
}

// Kinds 는 결정적 순서로 kind 를 돌려준다. 맵 순회 순서에 결과가 흔들리면 안 되는 곳에서
// 쓴다(트랜잭션 내 쓰기 순서 등).
func (p Payload) Kinds() []Kind {
	kinds := make([]Kind, 0, len(p))
	for kind := range p {
		kinds = append(kinds, kind)
	}
	for i := 1; i < len(kinds); i += 1 {
		for j := i; j > 0 && strings.Compare(string(kinds[j-1]), string(kinds[j])) > 0; j -= 1 {
			kinds[j-1], kinds[j] = kinds[j], kinds[j-1]
		}
	}
	return kinds
}
