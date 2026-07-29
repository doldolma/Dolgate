/**
 * 다음 tailnet 준비에서 등록을 다시 확인할지 표시해 두는 곳.
 *
 * 확인을 별도 요청으로 쏘지 않는 이유가 있다. 코어는 tailnet 당 시도 하나만 유지하고 새 시도가
 * 앞의 것을 접기 때문에, 확인과 재연결을 잇달아 쏘면 둘이 서로를 접는다 — 브라우저 로그인을
 * 기다리는 중에 접히고, 진행 상황도 어느 요청에도 붙지 않아 화면이 빈 채로 남는다.
 *
 * 그래서 표시만 남기고, 재연결이 태우는 그 하나의 요청에 실어 보낸다. 요청이 하나뿐이라
 * 진행 상황이 연결 화면에 그대로 보이고, 취소도 그것을 가리킨다.
 */
const pending = new Set<string>();

/** 다음 준비에서 등록을 다시 확인하게 한다. */
export function requestTailnetRelogin(tailnetId: string): void {
  const id = tailnetId.trim();
  if (id) {
    pending.add(id);
  }
}

/**
 * 표시를 소비한다. 한 번만 참이다 — 확인은 실패한 뒤의 한 번이고, 매 연결마다 하면 붙어 있는
 * 노드를 매번 닫아 재등록 왕복을 물린다.
 */
export function consumeTailnetRelogin(tailnetId: string): boolean {
  return pending.delete(tailnetId.trim());
}
