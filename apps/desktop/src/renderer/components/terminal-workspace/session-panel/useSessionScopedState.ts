// 세션마다 따로 기억하는 **화면 상태**(검색어·필터 …).
//
// 왜 필요한가: 세션 패널은 탭을 옮겨도 같은 컴포넌트를 재사용하고 `sessionId` 만 갈아끼운다.
// 그래서 그냥 `useState` 로 두면 A 에서 친 검색어가 B 로 넘어가, B 의 목록을 엉뚱하게 걸러
// 놓고는 "왜 안 보이지" 가 된다.
//
// 여기 두면 옮기는 즉시 그 세션의 값으로 갈아타고(없으면 초기값), 돌아오면 치던 것이 그대로
// 남는다. 목록 자체를 호스트 단위로 기억하는 것(useSessionDocker 의 listCache)과 같은 생각인데,
// 이쪽은 **세션 단위**다 — 같은 서버에 탭을 둘 열었으면 검색창은 각자의 것이어야 한다.
//
// 앱을 켜 둔 동안만 기억한다(설정에 남기지 않는다 — 보는 방식이지 설정이 아니다).

import { useCallback, useRef, useState } from 'react';

const store = new Map<string, Map<string, unknown>>();

/**
 * `scope` 단위로 기억하는 상태. `key` 는 한 세션 안에서 값을 구분한다(검색어·필터 …).
 *
 * `useState` 와 같은 모양이되 갱신 함수는 값만 받는다(함수형 갱신은 쓰지 않는다 — 화면 상태는
 * 늘 새 값으로 바꾼다).
 */
export function useSessionScopedState<T>(
  scope: string,
  key: string,
  initial: T,
): [T, (next: T) => void] {
  const read = (): T => {
    const bucket = store.get(scope);
    return bucket?.has(key) ? (bucket.get(key) as T) : initial;
  };

  const [value, setValue] = useState<T>(read);

  // 세션이 바뀌면 **그 자리에서** 갈아탄다. effect 로 미루면 직전 세션의 검색어가 한 프레임 더
  // 남아 새 목록을 거른다 — React 는 렌더 중의 이 갱신을 커밋 전에 흡수한다.
  const scopeRef = useRef(scope);
  if (scopeRef.current !== scope) {
    scopeRef.current = scope;
    setValue(read());
  }

  const set = useCallback(
    (next: T) => {
      const bucket = store.get(scopeRef.current) ?? new Map<string, unknown>();
      bucket.set(key, next);
      store.set(scopeRef.current, bucket);
      setValue(next);
    },
    [key],
  );

  return [value, set];
}

/** 세션이 사라지면 기억한 것도 놓는다. */
export function clearSessionScopedState(scope: string): void {
  store.delete(scope);
}
