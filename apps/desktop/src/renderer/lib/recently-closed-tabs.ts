// 최근 닫은 호스트 세션 스택(Cmd+Shift+T = '닫은 탭 다시 열기'용). "내용 복구"가 아니라
// 그냥 해당 호스트로 재연결만 하므로 hostId 만 보관한다. 휘발 모듈 레지스트리
// (terminal-cwd-registry 와 같은 결) — store 상태로 두지 않아 전역 리렌더가 없다.
//
// 닫은 순서 그대로(중복 호스트 포함) 쌓아, Cmd+Shift+T 를 반복하면 Chrome 처럼 역순으로
// 하나씩 되살린다. 같은 호스트 세션을 여러 개 닫았으면 그만큼 각각 되살아난다.

const MAX = 25;
const closedHostStack: string[] = [];

/** 호스트 세션 탭이 닫힐 때 hostId 를 스택에 쌓는다(중복도 그대로 — 각 닫기를 기억). */
export function pushClosedHost(hostId: string): void {
  if (!hostId) {
    return;
  }
  closedHostStack.push(hostId);
  if (closedHostStack.length > MAX) {
    closedHostStack.shift();
  }
}

/** 가장 최근 닫은 hostId 를 꺼낸다(없으면 null). */
export function popClosedHost(): string | null {
  return closedHostStack.pop() ?? null;
}

/** 테스트/리셋용. */
export function clearClosedHosts(): void {
  closedHostStack.length = 0;
}
