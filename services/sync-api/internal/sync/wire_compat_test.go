package sync

import (
	"encoding/json"
	"testing"
)

// 명명된 필드 구조체를 맵으로 바꾼 변경의 전제다: 와이어 포맷이 그대로여야 구버전
// 클라이언트와 섞여도 아무 일이 없다.
func TestPayloadWireFormatMatchesTheNamedFieldShape(t *testing.T) {
	encoded, err := json.Marshal(Payload{
		KindHosts: {{ID: "h1", EncryptedPayload: "c", UpdatedAt: "2026-01-01T00:00:00Z"}},
	})
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	const want = `{"hosts":[{"id":"h1","encrypted_payload":"c","updated_at":"2026-01-01T00:00:00Z"}]}`
	if string(encoded) != want {
		t.Errorf("Marshal() = %s, want %s", encoded, want)
	}
}

// 구버전 클라이언트가 보내는 JSON 은 명명된 필드 모양이다. 그대로 읽혀야 한다.
func TestPayloadReadsLegacyNamedFieldJSON(t *testing.T) {
	const legacy = `{"hosts":[{"id":"h1","encrypted_payload":"c","updated_at":"2026-01-01T00:00:00Z"}],"groups":[]}`

	var parsed Payload
	if err := json.Unmarshal([]byte(legacy), &parsed); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	if len(parsed[KindHosts]) != 1 {
		t.Errorf("hosts = %#v, want one record", parsed[KindHosts])
	}
	if _, ok := parsed[KindGroups]; !ok {
		t.Error("an explicit empty array should still register the kind")
	}
	// 구버전이 모르는 kind 는 아예 키가 없다 — 그래서 서버가 손대지 않는다.
	if _, ok := parsed[Kind("tailnets")]; ok {
		t.Error("a kind the client never sent must be absent, not empty")
	}
}

// 맵으로 바꾼 뒤 빈 kind 가 키째 사라진 것이 이미 배포된 클라이언트를 깨뜨렸다. 응답
// 직전 셋이 옛 모양을 되살리는지 본다 — 여기가 무너지면 그 앱들은 동기화가 멈춘다.
func TestWithLegacyWireKindsRestoresTheEmptyArrays(t *testing.T) {
	encoded, err := json.Marshal(Payload{
		KindHosts: {{ID: "h1", EncryptedPayload: "c", UpdatedAt: "2026-01-01T00:00:00Z"}},
	}.WithLegacyWireKinds())
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	const want = `{"awsProfiles":[],"dnsOverrides":[],"groups":[],"hosts":[{"id":"h1","encrypted_payload":"c","updated_at":"2026-01-01T00:00:00Z"}],"knownHosts":[],"portForwards":[],"preferences":[],"secrets":[],"snippets":[]}`
	if string(encoded) != want {
		t.Errorf("Marshal() = %s, want %s", encoded, want)
	}
}

// 셋은 채우기만 한다. 있는 레코드를 지우거나, 서버가 모르는 kind 를 떨어뜨리면 안 된다.
func TestWithLegacyWireKindsKeepsWhatIsAlreadyThere(t *testing.T) {
	filled := Payload{
		KindHosts:        {{ID: "h1"}},
		Kind("tailnets"): {{ID: "t1"}},
	}.WithLegacyWireKinds()

	if len(filled[KindHosts]) != 1 || filled[KindHosts][0].ID != "h1" {
		t.Errorf("hosts = %#v, want the original record", filled[KindHosts])
	}
	if len(filled[Kind("tailnets")]) != 1 {
		t.Errorf("tailnets = %#v, want the unknown kind untouched", filled[Kind("tailnets")])
	}
}

// 원본은 그대로여야 한다 — 저장소가 읽어 온 스냅샷에 서버가 kind 를 아는 흔적을 남기지 않는다.
func TestWithLegacyWireKindsDoesNotMutateTheSource(t *testing.T) {
	source := Payload{KindHosts: {{ID: "h1"}}}
	source.WithLegacyWireKinds()
	if len(source) != 1 {
		t.Errorf("source = %#v, want only the kind it had", source)
	}
}

// Kinds 는 맵 순회 순서에 흔들리지 않아야 한다 — 트랜잭션 내 쓰기 순서가 결과를 바꾸면
// 재현되지 않는 버그가 된다.
func TestPayloadKindsIsSorted(t *testing.T) {
	kinds := Payload{
		KindSnippets: {},
		KindHosts:    {},
		KindGroups:   {},
	}.Kinds()

	want := []Kind{KindGroups, KindHosts, KindSnippets}
	if len(kinds) != len(want) {
		t.Fatalf("Kinds() = %v, want %v", kinds, want)
	}
	for i := range want {
		if kinds[i] != want[i] {
			t.Fatalf("Kinds() = %v, want %v", kinds, want)
		}
	}
}
