import type { TailnetStatus } from '@shared';
import { appStore } from '../../store/appStore';
import { resumeReconnectsAfterHold } from '../../store/services/reconnect-orchestrator';
import { onTailnetStatus, snapshotTailnets } from './tailnet';

/**
 * tailnet 상태를 한곳에 모으는 곳.
 *
 * 화면마다 따로 읽으면 서로 다른 말을 한다 — 설정에서는 "연결됨" 인데 터미널 화면은 실패한 채로
 * 멈춰 있는 식이다. 노드는 tailnet 단위로 공유되므로 상태도 하나여야 한다. 여기서 모아 스토어에
 * 넣고, 화면들은 그것만 읽는다.
 *
 * 두 갈래로 들어온다. 연결 시험이 도는 동안은 코어가 상태 이벤트를 밀어 주고, 그 밖의 시간에는
 * 밀어 주는 것이 없어서 이쪽에서 읽는다(만료로 노드가 떨어지는 것 같은 변화는 아무도 알려 주지
 * 않는다).
 */
const snapshotIntervalMs = 1000;

let statusStreamStop: (() => void) | null = null;
let watchers = 0;
let timer: ReturnType<typeof setInterval> | null = null;

function mergeStatuses(statuses: readonly TailnetStatus[]): void {
  if (statuses.length === 0) {
    return;
  }
  let becameReady = false;
  appStore.setState((state) => {
    const next = { ...state.tailnetStatuses };
    for (const status of statuses) {
      if (status.ready === true && next[status.id]?.ready !== true) {
        becameReady = true;
      }
      next[status.id] = status;
    }
    return { tailnetStatuses: next };
  });

  // 로그인을 마쳐 이 계층이 열렸으면, 그것을 기다리며 막혀 있던 재연결이 백오프를 기다릴 이유가
  // 없다. 기다리게 두면 사용자가 로그인을 마쳐도 화면이 한동안 멈춘 것처럼 보인다.
  if (becameReady) {
    resumeReconnectsAfterHold();
  }
}

/**
 * 코어가 밀어 주는 상태를 받는다. 앱이 뜰 때 한 번 건다.
 *
 * 어느 화면이 시험을 시작했는지와 무관하게 받아야 한다 — 설정에서 시작한 연결의 진행을 터미널
 * 화면도 알아야 하고, 그 반대도 마찬가지다.
 */
export function startTailnetStatusStream(): () => void {
  statusStreamStop?.();
  statusStreamStop = onTailnetStatus((status) => {
    mergeStatuses([status]);
  });
  return () => {
    statusStreamStop?.();
    statusStreamStop = null;
  };
}

/**
 * 살아 있는 노드 상태를 주기적으로 읽는다. 보는 화면이 있는 동안만 돈다.
 *
 * 여러 화면이 동시에 볼 수 있어서 세어 둔다 — 각자 타이머를 돌리면 같은 조회가 겹친다.
 */
export function acquireTailnetWatch(): () => void {
  watchers += 1;
  if (watchers === 1) {
    const read = () => {
      void snapshotTailnets()
        .then((snapshot) => {
          mergeStatuses(snapshot.statuses);
          if (snapshot.localNodeName) {
            appStore.setState({ localTailnetNodeName: snapshot.localNodeName });
          }
        })
        .catch(() => {
          // 코어가 아직 안 떴거나 tailnet 지원이 꺼진 경우. 상태를 모르는 것뿐이다.
        });
    };
    read();
    timer = setInterval(read, snapshotIntervalMs);
  }

  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    watchers -= 1;
    if (watchers === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** 화면이 낙관적으로 바꾼 상태를 반영한다(연결 종료 직후 등). */
export function applyTailnetStatus(status: TailnetStatus): void {
  mergeStatuses([status]);
}

/** 노드가 사라진 tailnet 의 상태를 지운다(삭제·등록 해제 후). */
export function forgetTailnetStatus(tailnetId: string): void {
  appStore.setState((state) => {
    if (!(tailnetId in state.tailnetStatuses)) {
      return {};
    }
    const next = { ...state.tailnetStatuses };
    delete next[tailnetId];
    return { tailnetStatuses: next };
  });
}
