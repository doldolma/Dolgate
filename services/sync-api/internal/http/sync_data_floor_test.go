package http

import "testing"

// 계정 수준은 올라가기만 하고 내리는 길이 없다. 그래서 아직 뜻이 없는 값을 그대로 저장하면 안 된다 —
// 나중에 그 수준을 정의하는 순간 해당 데이터가 없는 계정까지 새 최소 버전을 요구받는다.
func TestParseSyncDataFloorHeaderClampsToKnownLevels(t *testing.T) {
	highest := highestKnownSyncDataFloor()
	if highest < 1 {
		t.Fatalf("적어도 수준 1(RDP 호스트)은 정의돼 있어야 한다, got %d", highest)
	}

	for _, testCase := range []struct {
		name   string
		header string
		want   int
	}{
		{name: "없으면 요구 없음", header: "", want: 0},
		{name: "공백만 있어도 요구 없음", header: "   ", want: 0},
		{name: "아는 수준은 그대로", header: "1", want: 1},
		{name: "공백을 무시한다", header: " 1 ", want: 1},
		{name: "0 은 요구 없음", header: "0", want: 0},
		{name: "모르는 큰 값은 아는 최고 수준까지", header: "2000000000", want: highest},
		{name: "음수는 클라이언트 버그이므로 무시", header: "-3", want: 0},
		{name: "숫자가 아니면 무시", header: "여기에-왜-이런-값이", want: 0},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			if got := parseSyncDataFloorHeader(testCase.header); got != testCase.want {
				t.Fatalf("parseSyncDataFloorHeader(%q) = %d, want %d", testCase.header, got, testCase.want)
			}
		})
	}
}

// 게이트는 누적이다. 수준 N 이면 1..N 의 요구를 모두 만족해야 한다.
func TestRequiredClientVersionForFloorSkipsUnknownLevels(t *testing.T) {
	if got := requiredClientVersionForFloor(1, "desktop"); got != "1.9.0" {
		t.Fatalf("desktop floor 1 = %q, want 1.9.0", got)
	}
	// clamp 를 거치지 않고 들어온 값(이미 DB 에 저장된 옛 값)도 아는 수준만큼만 요구해야 한다.
	if got := requiredClientVersionForFloor(999, "desktop"); got != "1.9.0" {
		t.Fatalf("desktop floor 999 = %q, want 1.9.0", got)
	}
	// 목록에 없는 클라이언트는 게이트하지 않는다 — 새 클라이언트를 붙일 때마다 서버를 먼저 고쳐야
	// 하는 상황을 피한다.
	if got := requiredClientVersionForFloor(1, "mobile"); got != "" {
		t.Fatalf("mobile floor 1 = %q, want empty", got)
	}
	if got := requiredClientVersionForFloor(1, ""); got != "" {
		t.Fatalf("unnamed client floor 1 = %q, want empty", got)
	}
}
