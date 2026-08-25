// 호스트별 마지막 연결 시각(ms).
//
// 활동 로그에서 뽑는다. **`session` 종류만 본다** — `audit` 은 이름 변경·자격 증명 저장 같은
// 편집 기록이고 그것도 `metadata.hostId` 를 갖는다. 종류를 가리지 않으면 호스트를 고치기만 해도
// "최근 접속" 이 오늘로 바뀐다.
//
// 호스트 목록 정렬(useHostBrowser)과 새 탭 말풍선이 함께 쓴다 — 두 벌로 두면 "최근" 의 뜻이
// 화면마다 갈린다.

import type { ActivityLogRecord } from '@shared';

export function buildLastConnectedByHostId(
  activityLogs: readonly ActivityLogRecord[] | undefined,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const log of activityLogs ?? []) {
    if (log.category !== 'session') {
      continue;
    }
    const metadata = log.metadata as { hostId?: string } | null;
    const hostId = metadata?.hostId;
    if (!hostId) {
      continue;
    }
    const timestamp = Date.parse(log.createdAt);
    if (Number.isNaN(timestamp)) {
      continue;
    }
    const previous = map.get(hostId);
    if (previous === undefined || timestamp > previous) {
      map.set(hostId, timestamp);
    }
  }
  return map;
}
