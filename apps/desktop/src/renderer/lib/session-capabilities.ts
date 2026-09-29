import type { TerminalTab } from '@shared';

/** 호스트 설정이 아니라 이번 연결에서 확인된 사실만 사용한다. */
export function getSessionCapabilities(tab: TerminalTab | null | undefined) {
  const protocol = tab?.sessionProtocol
    ?? (tab?.awsTransport === 'ssh-over-ssm' ? 'ssh'
      : tab?.awsTransport === 'ssm-shell' ? 'ssm-shell'
        // control-mode pane은 SSH에서만 생성된다. 부모 탭이 제거된 뒤에도 성립한다.
        : tab?.tmux ? 'ssh' : undefined);
  const ssh = protocol === 'ssh' && tab?.shellKind !== 'aws-ecs-exec';
  return {
    zmodem: ssh || (tab?.source === 'local' && tab?.shellKind !== 'aws-ecs-exec'),
    shellIntegration: ssh,
    // 공유 가능 여부와 별개다. SSM 셸도 공유하며 제어 키만 다른 경로로 보낸다.
    shareTransport: protocol === 'ssm-shell' ? 'aws-ssm' as const : 'ssh' as const,
  };
}
