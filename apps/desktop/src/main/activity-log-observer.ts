import type { ActivityLogRecord } from "@shared";

/** 잇따라 쓴 기록을 화면에 알리기까지 모으는 시간. 화면도 받은 뒤 조금 기다렸다 다시 읽는다. */
export const ACTIVITY_LOGS_CHANGED_DELAY_MS = 100;

/**
 * 기록이 바뀌었다고 창마다 알린다 — 잇따라 쓰면 짧게 모아 한 번만 보낸다. 보낸 뒤에 쓴 것은 다음 한 번에 실린다.
 * 전에는 접속 수명 줄과 접속 실패만 알려서, 가져오기·호스트 키 신뢰·내보내기 같은 줄은 화면이 다른 일로 다시 읽을
 * 때까지 기록 화면에 안 보였다.
 */
export function createActivityLogsChangedNotifier(broadcast: () => void, delayMs = ACTIVITY_LOGS_CHANGED_DELAY_MS) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    notify(): void {
      if (timer) {
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        broadcast();
      }, delayMs);
    },
    dispose(): void {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

/** 기록 저장소가 쓴 줄마다 부르는 것 — 화면에 알리고, 팀 볼트 것이면 팀 기록에 올린다. 올리기가 실패해도 알림은 간다. */
export function createActivityLogObserver(deps: { notifyChanged: () => void; mirror: (record: ActivityLogRecord) => void }) {
  return (record: ActivityLogRecord): void => {
    deps.notifyChanged();
    deps.mirror(record);
  };
}
