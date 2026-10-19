package http

// WaitersForTest 는 지금 걸려 있는 GET /sync/watch 대기 수다. 외부 테스트(http_test)가 대기가
// 실제로 걸린 뒤에 push 하도록 기다리는 데 쓴다. 테스트 빌드에만 있다.
func (h *SyncWatchHub) WaitersForTest() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	total := 0
	for _, entry := range h.entries {
		total += entry.waiters
	}
	return total
}

// SetTeamDataFloorMinimumVersionsForTest 는 팀 데이터 수준 표를 잠시 바꾼다. 돌려준 함수로 되돌린다.
// 지금은 형식이 하나뿐이라 표가 비어 있어, 게이트를 시험하려면 수준을 하나 정의해야 한다.
func SetTeamDataFloorMinimumVersionsForTest(levels map[int]map[string]string) func() {
	previous := teamDataFloorMinimumVersions
	teamDataFloorMinimumVersions = levels
	return func() { teamDataFloorMinimumVersions = previous }
}
