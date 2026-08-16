import type { PendingHostKeyPrompt } from "../types";

/**
 * 호스트 키 신뢰 물음은 **한 번에 하나만** 보여 주고 나머지는 줄을 세운다.
 *
 * **왜 큐가 필요한가:** 예전에는 슬롯이 하나여서 새 물음이 오면 앞의 것을 덮어썼다. 덮인 물음은
 * 화면에서 사라지지만 코어는 그것을 계속 기다린다 — 아무도 답할 수 없으므로 그 연결은 예산
 * (5분)이 다 될 때까지 "연결 중…"에 앉아 있고, tailnet 을 경유하면 그 노드의 리스까지 붙잡는다.
 *
 * 앱을 켤 때 세션을 여러 개 복원하거나, 같은 베스천 뒤의 호스트 두 개를 한꺼번에 열면 실제로 겹친다.
 *
 * **왜 여러 개를 동시에 띄우지 않는가:** 이건 모달이다. 지문을 대조해 판단하는 화면을 여러 장
 * 겹쳐 놓으면 사용자가 지금 무엇을 승인하는지 알기 어렵다. 하나씩 처리하고 다음을 올린다.
 */
export interface HostKeyPromptQueueState {
  pendingHostKeyPrompt: PendingHostKeyPrompt | null;
  queuedHostKeyPrompts: PendingHostKeyPrompt[];
}

/**
 * 새 물음을 받는다. 보여 주는 것이 없으면 바로 띄우고, 있으면 뒤에 세운다.
 *
 * 같은 챌린지 ID 가 다시 오면 무시한다 — 코어가 같은 물음을 두 번 올리는 일은 없어야 하지만,
 * 겹쳐 쌓이면 사용자가 같은 지문을 두 번 승인해야 한다.
 */
export function enqueueHostKeyPrompt(
  state: HostKeyPromptQueueState,
  prompt: PendingHostKeyPrompt,
): HostKeyPromptQueueState {
  if (isSameHostKeyPrompt(state.pendingHostKeyPrompt, prompt)) {
    return { ...state, pendingHostKeyPrompt: prompt };
  }
  if (state.queuedHostKeyPrompts.some((queued) => isSameHostKeyPrompt(queued, prompt))) {
    return state;
  }
  if (!state.pendingHostKeyPrompt) {
    return { pendingHostKeyPrompt: prompt, queuedHostKeyPrompts: state.queuedHostKeyPrompts };
  }
  return {
    pendingHostKeyPrompt: state.pendingHostKeyPrompt,
    queuedHostKeyPrompts: [...state.queuedHostKeyPrompts, prompt],
  };
}

/**
 * 지금 보여 주던 물음을 끝내고 다음을 올린다. 없으면 비운다.
 *
 * 답한 뒤에도 이것을 부르지 않으면 줄에 선 물음이 영영 안 뜬다 — 덮어쓰기와 증상이 같다.
 */
export function shiftHostKeyPrompt(
  state: HostKeyPromptQueueState,
): HostKeyPromptQueueState {
  const [next, ...rest] = state.queuedHostKeyPrompts;
  return {
    pendingHostKeyPrompt: next ?? null,
    queuedHostKeyPrompts: rest,
  };
}

/**
 * 사라진 세션의 물음을 버린다. 보여 주던 것을 버렸으면 다음을 올린다.
 *
 * 줄에 선 것을 남겨 두면 이미 없는 세션을 가리킨 채 나중에 올라온다 — 사용자는 어느 연결을
 * 승인하는지 알 수 없고, 답은 이미 끝난 대기표로 간다.
 */
export function dropHostKeyPromptsForSession(
  state: HostKeyPromptQueueState,
  sessionId: string,
): HostKeyPromptQueueState {
  const queued = state.queuedHostKeyPrompts.filter(
    (prompt) => prompt.sessionId !== sessionId,
  );
  if (state.pendingHostKeyPrompt?.sessionId !== sessionId) {
    return {
      pendingHostKeyPrompt: state.pendingHostKeyPrompt,
      queuedHostKeyPrompts: queued,
    };
  }
  const [next, ...rest] = queued;
  return { pendingHostKeyPrompt: next ?? null, queuedHostKeyPrompts: rest };
}

/**
 * 세션 ID 가 바뀌면(재연결로 탭이 새 세션을 받으면) 줄에 선 것까지 함께 옮긴다.
 *
 * 보여 주는 것만 옮기면, 줄에 있던 물음은 사라진 세션을 가리킨 채 올라와서 답이 엉뚱한 곳으로 간다.
 */
export function remapHostKeyPromptSessionId(
  state: HostKeyPromptQueueState,
  previousSessionId: string,
  nextSessionId: string,
): HostKeyPromptQueueState {
  const remap = (prompt: PendingHostKeyPrompt): PendingHostKeyPrompt =>
    prompt.sessionId === previousSessionId
      ? { ...prompt, sessionId: nextSessionId }
      : prompt;
  return {
    pendingHostKeyPrompt: state.pendingHostKeyPrompt
      ? remap(state.pendingHostKeyPrompt)
      : null,
    queuedHostKeyPrompts: state.queuedHostKeyPrompts.map(remap),
  };
}

/**
 * 같은 물음인지. 살아 있는 질의는 챌린지 ID 가 신원이고, 연결 전 프로브 경로는 그것이 없으므로
 * 대상 주소로 본다.
 */
function isSameHostKeyPrompt(
  left: PendingHostKeyPrompt | null,
  right: PendingHostKeyPrompt,
): boolean {
  if (!left) {
    return false;
  }
  if (left.liveChallengeId || right.liveChallengeId) {
    return left.liveChallengeId === right.liveChallengeId;
  }
  return (
    left.probe.host === right.probe.host && left.probe.port === right.probe.port
  );
}
