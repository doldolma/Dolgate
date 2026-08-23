// 포트 전달 규칙의 상태 표기. 포트 화면과 세션 패널이 같은 한 벌을 쓴다 — 두 곳이 다른 말을
// 쓰면 같은 규칙이 다른 상태인 것처럼 보인다.

import type { PortForwardRuntimeRecord } from '@shared';
import type { StatusBadgeTone } from '../ui/StatusBadge';
import { resolveConnectionFailurePresentation } from '../store/utils';

export function portForwardStatusLabel(runtime?: PortForwardRuntimeRecord | null): string {
  switch (runtime?.status) {
    case 'starting':
      return 'Starting';
    case 'running':
      return 'Running';
    case 'error':
      return 'Error';
    default:
      return 'Stopped';
  }
}

export function portForwardStatusTone(status?: string | null): StatusBadgeTone {
  switch (status) {
    case 'running':
      return 'running';
    case 'starting':
      return 'starting';
    case 'paused':
      return 'paused';
    case 'error':
      return 'error';
    default:
      return 'stopped';
  }
}

/**
 * 런타임 실패 문구를 사람이 읽는 문장으로. 포트 화면과 세션 패널이 같은 함수를 쓴다.
 *
 * 여기서 새로 분류하지 않는다 — 코어 원문을 코드로 가르는 일은 이미 shared-core 의
 * `getConnectionFailureReason` 이 하고(모바일과 공유), 문구는 데스크톱의
 * `resolveConnectionFailurePresentation` 이 붙인다. 포트 포워딩만 그 계층에 연결돼 있지
 * 않아서 `open local listener: listen tcp …: bind: address already in use` 가 화면에 그대로
 * 떴다(그 함수 주석은 포트포워딩을 대상으로 적고 있었다).
 *
 * 분류되지 않은 오류는 원문이 그대로 돌아온다 — 알 수 없는 실패를 뭉뚱그린 문구로 덮으면
 * 무엇이 잘못됐는지 알 단서가 사라진다.
 */
export function portForwardFailureMessage(
  runtime?: PortForwardRuntimeRecord | null,
): string | null {
  const raw = runtime?.message?.trim();
  if (!raw) {
    return null;
  }
  return resolveConnectionFailurePresentation(raw).message;
}
