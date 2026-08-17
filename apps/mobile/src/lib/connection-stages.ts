// 연결 진행을 이 앱의 문구로 바꾼다.
//
// 단계를 정하는 일은 shared-core 가 한다(데스크톱과 같은 것을 보여줘야 하고, tailnet 계층의 판정에는
// 쉽게 얻은 것이 아닌 규칙들이 들어 있다). 여기서 하는 것은 두 가지뿐이다: 이 앱의 연결 상태를 그
// 계산의 입력으로 옮기는 것, 그리고 돌아온 i18n 키를 문구로 바꾸는 것.

import i18next from 'i18next';
import {
  resolveConnectionStages,
  type ConnectionStage,
  type ConnectionStageDetailPart,
} from '@dolssh/shared-core';
import type { MobileConnectionViewState } from '../store/useMobileAppStore';

export type { ConnectionStage } from '@dolssh/shared-core';

/**
 * 코어가 지금 무엇을 하는 중인지.
 *
 * 데스크톱은 세션 매니저가 보내는 진행 단계를 그대로 쓰지만, 모바일의 Connect 는 한 번의 호출이라
 * 그런 보고가 없다. 대신 **사람에게 무엇을 묻고 있는지**로 알 수 있다 — 키를 묻는 중이면 아직 키
 * 관문이고, 코드를 묻는 중이면 키는 이미 지나 인증에 들어간 것이다.
 */
function stageOf(view: MobileConnectionViewState): string {
  if (view.hostKeyPrompted) {
    return 'awaiting-host-trust';
  }
  if (view.interactiveAuthPending) {
    // 인증까지 왔다는 뜻이다. 키 관문은 그 앞에 끝났다.
    return 'waiting-interactive-auth';
  }
  return 'host-key-check';
}

export function resolveMobileConnectionStages(input: {
  view: MobileConnectionViewState | undefined;
  /** 이 연결의 상태('connecting' | 'connected' | 'error' …). */
  status: string | null | undefined;
}): ConnectionStage[] {
  const { view } = input;
  if (!view) {
    return [];
  }
  const stages = resolveConnectionStages({
    subject: { status: input.status, stage: stageOf(view) },
    hasTailscale: view.hasTailnet,
    tailnetStatus: view.tailnetStatus,
    targetAddress: view.targetAddress,
    // 모바일이 붙는 것은 SSH 뿐이다(AWS 는 자기 화면을 쓴다). 종류를 넘기지 않으면 SSH 로 본다.
    failureLayer: view.failureLayer ?? null,
    failureMessage: view.failureMessage,
    hostKeyPrompted: view.hostKeyPrompted,
  });

  // 어느 홉을 붙고 있는지를 SSH 관문에 붙인다.
  //
  // 이것이 없으면 점프 체인은 통째로 "SSH 연결" 한 줄이고, 베스천에서 막힌 것과 그 뒤 대상에서
  // 막힌 것이 같은 모양으로 보인다 — 실기기에서 어디서 멈췄는지 알 수 없었던 것이 이 때문이다.
  //
  // 공유 계산에 넣지 않는 이유: 데스크톱은 홉을 자기 화면(체인 표시)으로 이미 보여준다. 여기서
  // 넣으면 그 화면에 같은 정보가 두 번 뜬다.
  const hop = view.hop;
  if (hop && hop.hopCount > 1 && !view.failureMessage) {
    const sshStage = stages.find(stage => stage.id === 'ssh');
    if (sshStage) {
      sshStage.detail = [
        ...(sshStage.detail ?? []),
        {
          key: 'connectStages.hopDetail',
          params: {
            index: hop.hopIndex,
            count: hop.hopCount,
            label: hop.hopLabel,
          },
        },
      ];
    }
  }
  return stages;
}

function describePart(part: ConnectionStageDetailPart): string {
  return 'text' in part ? part.text : i18next.t(part.key, part.params);
}

/**
 * 단계를 화면에 쓸 문구로.
 *
 * 조각을 ' · ' 로 잇는다 — 번역된 안내와 백엔드 원문이 한 줄에 함께 오는 경우가 있어서(로그인 거부
 * 이유, 주고받은 양) 한 문장으로 합치면 원문이 어디부터인지 알 수 없다.
 */
export function describeConnectionStage(stage: ConnectionStage): {
  label: string;
  detail?: string;
} {
  const detail = stage.detail?.map(describePart).filter(Boolean).join(' · ');
  return {
    label: i18next.t(stage.label.key, stage.label.params),
    detail: detail || undefined,
  };
}

export function describeStageGroup(group: ConnectionStage['group']): string {
  return i18next.t(
    group === 'tailscale'
      ? 'connectStages.groupTailscale'
      : 'connectStages.groupHost',
  );
}
