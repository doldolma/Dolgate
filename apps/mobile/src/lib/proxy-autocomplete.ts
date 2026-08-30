import type { AwsSsmSessionServerMessage } from '@dolssh/shared-core';
import type { EngineAutocompleteResult } from '../engine/types';

/**
 * 서버 프록시 세션의 자동완성 왕복.
 *
 * 이 기기에는 SSH 연결이 없다 — SSM 데이터채널을 쥔 쪽은 서버다. 그래서 코어를 직접 부르는
 * 대신 세션 소켓으로 부탁하고, 같은 소켓으로 돌아오는 답을 맞춘다. 데스크톱이 같은 소켓에
 * 대해 하는 일과 같다(core-manager 의 requestAwsServerProxyAutocomplete).
 *
 * **답이 한 통이 아니다.** 코어는 한 번의 요청에 정해진 순서로 보낸다:
 *
 * 1. capability `status: "probing"` — requestId **없음**
 * 2. snapshot — 재료가 모였을 때만, requestId **없음**
 * 3. capability — requestId **있음**. 이것이 최종 답이다.
 * 4. shellState — 셸을 알아냈을 때만, requestId 없음
 *
 * 그래서 두 가지를 지켜야 한다. requestId 없는 capability 를 답으로 오해하지 말 것(1번을 답으로
 * 받으면 늘 "probing" 만 보게 된다), 그리고 스냅샷을 담아 두었다가 3번에서 함께 매듭지을 것.
 */
export interface ProxyAutocompleteExchange {
  /** 서버에 요청을 보내고 최종 답을 기다린다. */
  request(
    type: 'autocompletePrepare' | 'autocompleteRefresh',
  ): Promise<EngineAutocompleteResult>;
  /** 이 왕복에 속한 메시지였으면 true. 아니면 호출한 쪽이 계속 처리한다. */
  accept(message: AwsSsmSessionServerMessage): boolean;
  /** 소켓이 끊겼다. 미결을 모두 깨운다 — 안 그러면 훅이 시간이 다 갈 때까지 묶인다. */
  rejectAll(why: string): void;
}

interface Pending {
  resolve: (result: EngineAutocompleteResult) => void;
  reject: (error: Error) => void;
  cancelTimeout: () => void;
  snapshot: EngineAutocompleteResult['snapshot'];
}

export function createProxyAutocompleteExchange(options: {
  send: (payload: { type: string; requestId: string }) => void;
  timeoutMs: number;
}): ProxyAutocompleteExchange {
  const pending = new Map<string, Pending>();
  let seq = 0;

  /**
   * requestId 없이 온 스냅샷의 주인. 미결이 정확히 하나일 때만 그 요청의 것으로 본다 — 둘
   * 이상이면 어느 쪽 답인지 알 수 없고, 잘못 붙이면 다른 요청에 남의 재료를 준다. 그럴 땐
   * 스냅샷 없이 간다(capability 만 있어도 기록·실행 파일 추천은 동작한다).
   */
  const solePending = (): Pending | null => {
    if (pending.size !== 1) return null;
    for (const entry of pending.values()) return entry;
    return null;
  };

  return {
    request(type) {
      return new Promise<EngineAutocompleteResult>((resolve, reject) => {
        // 한 소켓 안에서 미결끼리만 구분되면 된다 — 서버는 이 값을 그대로 돌려줄 뿐이다.
        const requestId = `ac-${(seq += 1)}`;
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error('Timed out waiting for the autocomplete probe.'));
        }, options.timeoutMs);
        pending.set(requestId, {
          resolve,
          reject,
          cancelTimeout: () => clearTimeout(timer),
          snapshot: null,
        });
        try {
          options.send({ type, requestId });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(requestId);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },

    accept(message) {
      if (message.type === 'autocompleteSnapshot') {
        const entry = message.requestId
          ? pending.get(message.requestId)
          : solePending();
        if (entry) entry.snapshot = message.payload;
        return true;
      }
      if (message.type === 'autocompleteCapability') {
        // **여기서는 스냅샷과 달리 주인을 찍지 않는다.** 중간 보고("probing")도 이 타입으로
        // 오는데 requestId 가 없다 — 미결 하나에 갖다 붙이면 답이 오기도 전에 "준비 중" 으로
        // 매듭지어 버린다.
        const requestId = message.requestId;
        if (!requestId) return true;
        const entry = pending.get(requestId);
        if (!entry) return true;
        entry.cancelTimeout();
        pending.delete(requestId);
        entry.resolve({ capability: message.payload, snapshot: entry.snapshot });
        return true;
      }
      // 셸 이름은 capability 에 이미 실려 온다. 이 통은 데스크톱이 상태 표시에 쓰는 것이라
      // 여기서는 삼키기만 한다 — 흘려보내면 호출한 쪽의 "모르는 메시지" 처리에 걸린다.
      return message.type === 'autocompleteShellState';
    },

    rejectAll(why) {
      for (const entry of pending.values()) {
        entry.cancelTimeout();
        entry.reject(new Error(why));
      }
      pending.clear();
    },
  };
}
