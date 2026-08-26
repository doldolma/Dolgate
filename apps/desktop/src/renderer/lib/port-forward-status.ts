// 포트 전달 규칙의 상태 표기. 포트 화면과 세션 패널이 같은 한 벌을 쓴다 — 두 곳이 다른 말을
// 쓰면 같은 규칙이 다른 상태인 것처럼 보인다.

import type { DnsOverrideResolvedRecord, PortForwardRuntimeRecord } from '@shared';
import { isInternalTransportTunnel } from '@shared';
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

/**
 * 지금 쓰이고 있는 포워딩. `running` 과 `starting` 을 함께 센다.
 *
 * **판정을 한 곳에 둔다.** 예전에는 AppShell 이 업데이트 설치를 막을지 정할 때만 이 조건을
 * 인라인으로 갖고 있었다. 같은 질문을 묻는 화면이 늘어나면(사이드바 배지, 탭 hover) 조건이
 * 갈라지고, 배지는 2개라는데 업데이트는 안 막히는 상태가 된다.
 *
 * `starting` 을 세는 이유: 아직 열리지 않았어도 사용자가 켠 것이고, OTP 를 묻는 호스트에서는
 * 그 상태가 몇십 초 이어진다. 그동안 "없다" 고 말하면 켠 사람이 자기 행동을 못 찾는다.
 *
 * `error` 는 세지 않는다. 실패한 규칙의 이유는 규칙 카드와 세션 패널 행에 이미 붙어 있고
 * (portForwardFailureMessage), 개수에 섞으면 그 수가 무엇을 뜻하는지 흐려진다.
 */
export function isActivePortForward(runtime: PortForwardRuntimeRecord): boolean {
  return runtime.status === 'running' || runtime.status === 'starting';
}

/** 이 호스트로 열려 있는 포워딩들. 탭 hover 가 어느 포트인지까지 보여줄 때 쓴다. */
export function activePortForwardsForHost(
  runtimes: readonly PortForwardRuntimeRecord[],
  hostId: string | null | undefined,
): PortForwardRuntimeRecord[] {
  if (!hostId) {
    return [];
  }
  return runtimes.filter(
    (runtime) => runtime.hostId === hostId && isActivePortForward(runtime),
  );
}

/** 전체 실행 중 개수. 사이드바 배지가 쓴다. */
export function countActivePortForwards(
  runtimes: readonly PortForwardRuntimeRecord[],
): number {
  return runtimes.filter(isActivePortForward).length;
}

/**
 * 켜져 있는 DNS override 수.
 *
 * `status` 는 백엔드가 해석해서 준다(DnsOverrideResolvedRecord) — linked 는 연결된 규칙이
 * 돌 때, static 은 사용자가 켰을 때 `active` 다. 여기서 두 종류를 다시 가르지 않는다.
 */
export function countActiveDnsOverrides(
  overrides: readonly DnsOverrideResolvedRecord[],
): number {
  return overrides.filter((override) => override.status === 'active').length;
}

/**
 * 포트 포워딩 화면에서 지금 쓰이고 있는 항목 수. 사이드바 배지가 이것을 보여 준다.
 *
 * **다섯 탭을 모두 센다** — SSH·AWS EC2·ECS Task·Container 포워딩과 DNS override. 배지는
 * "그 화면에 켜 둔 것이 있는가" 를 말하는 것이므로 한 탭만 세면 다른 탭에 켜 둔 것을 못 찾는다.
 * 포워딩 네 종류는 transport 로 구분되지만 판정은 status 뿐이라 자연히 다 들어간다.
 *
 * **linked DNS override 는 그 규칙과 따로 센다.** 하나의 터널에 하나의 이름을 붙였으면 2가 된다.
 * 사용자가 만들고 켠 항목이 둘이고 화면에도 둘로 보이므로, "구분되는 터널 수" 가 아니라 "켜 둔
 * 항목 수" 를 세는 것이 배지의 뜻과 맞다.
 *
 * **우리가 여는 전송 터널은 빼고 센다.** RDP-over-SSM·VNC-over-SSH 는 붙는 동안 터널을 하나씩
 * 여는데, 그것은 사용자가 만든 규칙이 아니라 연결의 구현 세부라 이 화면에 나오지 않는다. 세어
 * 버리면 배지에 1이 뜨는데 눌러 들어가면 아무것도 없다 — 사용자는 자기가 켠 적 없는 것을 찾게
 * 된다. 판정은 감사 로그와 같은 것을 쓴다(shared-core 의 isInternalTransportTunnel).
 *
 * 업데이트 설치를 막을지 정하는 판정(AppShell)과 일부러 다른 함수다. 그쪽 질문은 "다시 시작하면
 * 끊기는 것이 있는가" 이고, 전송 터널도 끊기므로 그쪽은 **함께 센다**.
 */
export function countActivePortForwardEntries(
  runtimes: readonly PortForwardRuntimeRecord[],
  overrides: readonly DnsOverrideResolvedRecord[],
): number {
  const visible = runtimes.filter((runtime) => !isInternalTransportTunnel(runtime.ruleId));
  return countActivePortForwards(visible) + countActiveDnsOverrides(overrides);
}
