// 포트 포워딩 섹션. **이 세션의 호스트에 걸린 규칙만** 보여 준다 — 패널의 유일한 규칙이 그것이다.
//
// 여기서 시작·정지까지 한다. "패널은 보기" 규칙의 예외인데, 이유가 있다 — 그 규칙은 같은 것을
// 두 곳에서 *편집*하면 어느 쪽이 최신인지 알 수 없게 되는 것을 막으려는 것이고, 시작·정지는
// 설정이 없는 두 상태 토글이라 그 위험이 없다(상태도 스토어 하나를 함께 본다).
//
// 규칙 편집도 여기서 한다. 편집기는 포트 화면과 **같은 한 벌**이고(AppModals 의
// PortForwardEditorHost), 규칙과 저장 경로도 스토어 하나라(portForwards / savePortForward)
// 두 곳에서 고쳐도 어긋날 데가 없다. 화면을 옮기지 않는 것이 요점이다 — 포트 하나 고치려고
// 작업 중인 터미널을 떠나게 하면 안 된다.
//
// 삭제와 DNS 오버라이드는 여전히 포트 화면의 몫이다(아래 "규칙 관리").

import { useMemo } from 'react';
import { isAwsEc2HostRecord } from '@shared';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../../store/appStore';
import {
  portForwardFailureMessage,
  portForwardStatusLabel,
  portForwardStatusTone,
} from '../../../lib/port-forward-status';
import { Button, StatusBadge, Tooltip } from '../../../ui';
import { Pencil, Play, Square } from '../../../ui/icons';
import { SessionPanelEmpty } from './SessionPanelEmpty';

interface SessionPanelPortsProps {
  /** 이 세션의 호스트. 로컬 터미널처럼 호스트가 없는 세션에서는 null. */
  hostId: string | null;
}

const ACTION_CLASS =
  'grid h-6 w-6 shrink-0 place-items-center rounded-[7px] text-[var(--text-soft)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text)]';

export function SessionPanelPorts({ hostId }: SessionPanelPortsProps) {
  const { t: translate } = useTranslation();
  const portForwards = useAppStore((state) => state.portForwards);
  const runtimes = useAppStore((state) => state.portForwardRuntimes);
  const openPortForwardEditor = useAppStore((state) => state.openPortForwardEditor);
  const hosts = useAppStore((state) => state.hosts);
  const startPortForward = useAppStore((state) => state.startPortForward);
  const stopPortForward = useAppStore((state) => state.stopPortForward);

  const rows = useMemo(() => {
    if (!hostId) {
      return [];
    }
    const runtimeByRuleId = new Map(
      runtimes.map((runtime) => [runtime.ruleId, runtime]),
    );
    return portForwards
      .filter((rule) => rule.hostId === hostId)
      .map((rule) => ({ rule, runtime: runtimeByRuleId.get(rule.id) ?? null }))
      // 돌고 있는 것을 위로. "지금 열린 포트" 를 보러 오는 섹션이다.
      .sort((left, right) => {
        const leftRunning = left.runtime?.status === 'running' ? 0 : 1;
        const rightRunning = right.runtime?.status === 'running' ? 0 : 1;
        return leftRunning - rightRunning || left.rule.bindPort - right.rule.bindPort;
      });
  }, [hostId, portForwards, runtimes]);

  /**
   * 새 규칙을 어느 방식으로 만들지. 호스트 종류가 정한다 — AWS EC2 는 SSM 터널로 나가고 그
   * 밖은 SSH 다. 편집기에서 다시 고를 수 있지만, 처음부터 맞는 것이 떠 있어야 한다.
   */
  const addTransport: 'ssh' | 'aws-ssm' = useMemo(() => {
    const host = hostId ? hosts.find((candidate) => candidate.id === hostId) : undefined;
    return host && isAwsEc2HostRecord(host) ? 'aws-ssm' : 'ssh';
  }, [hostId, hosts]);

  if (rows.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
        <SessionPanelEmpty
          title={translate('sessionPanel.ports.emptyTitle')}
          description={translate(
            hostId ? 'sessionPanel.ports.empty' : 'sessionPanel.ports.noHost',
          )}
        >
          {hostId ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                openPortForwardEditor({ kind: 'create', transport: addTransport, hostId })
              }
            >
              {translate('sessionPanel.ports.add')}
            </Button>
          ) : null}
        </SessionPanelEmpty>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pt-2">
        {rows.map(({ rule, runtime }) => {
          const status = runtime?.status ?? 'stopped';
          const active = status === 'running' || status === 'starting';
          return (
            <div key={rule.id} className="rounded-[9px] px-2.5 py-1.5">
              <div className="flex items-baseline gap-2">
                {/* 규칙을 알아보는 이름이 먼저다 — 기존 포트 화면도 라벨을 제목으로 둔다.
                    주소는 아래 줄의 매핑에서 본다. */}
                <span className="min-w-0 flex-1 truncate text-[0.78rem] text-[var(--text)]">
                  {rule.label || `${rule.bindAddress}:${rule.bindPort}`}
                </span>
                {/* 상태 표기는 포트 화면과 같은 한 벌을 쓴다(lib/port-forward-status). */}
                <StatusBadge tone={portForwardStatusTone(status)} className="shrink-0">
                  {portForwardStatusLabel(runtime)}
                </StatusBadge>
                {/* 편집은 팝업으로 띄운다 — 화면을 옮기지 않는다. 돌고 있는 규칙도 열 수 있게
                    둔다: 포트를 바꾸려면 정지부터 해야 하는 것을 편집 창에서 알게 되는 편이,
                    버튼이 사라져 왜 못 고치는지 모르는 것보다 낫다. */}
                <Tooltip label={translate('sessionPanel.ports.edit')}>
                  <button
                    type="button"
                    aria-label={translate('sessionPanel.ports.edit')}
                    onClick={() => openPortForwardEditor({ kind: 'edit', ruleId: rule.id })}
                    className={ACTION_CLASS}
                  >
                    <Pencil className="h-3 w-3" aria-hidden />
                  </button>
                </Tooltip>
                {/* 시작 중에도 정지를 남긴다 — OTP 를 묻는 호스트에서 몇십 초 걸릴 수 있고,
                    그때 접을 방법이 없으면 화면이 "starting" 으로 굳은 것처럼 보인다. */}
                {active ? (
                  <Tooltip label={translate('sessionPanel.ports.stop')}>
                    <button
                      type="button"
                      aria-label={translate('sessionPanel.ports.stop')}
                      onClick={() => void stopPortForward(rule.id)}
                      className={ACTION_CLASS}
                    >
                      <Square className="h-3 w-3" aria-hidden />
                    </button>
                  </Tooltip>
                ) : (
                  <Tooltip label={translate('sessionPanel.ports.start')}>
                    <button
                      type="button"
                      aria-label={translate('sessionPanel.ports.start')}
                      onClick={() => void startPortForward(rule.id)}
                      className={ACTION_CLASS}
                    >
                      <Play className="h-3 w-3" aria-hidden />
                    </button>
                  </Tooltip>
                )}
              </div>
              <p className="truncate font-mono text-[0.7rem] text-[var(--text-soft)]">
                {describeMapping(rule)}
              </p>
              {/* 실패한 규칙은 이유를 보여 준다 — 상태만 보면 왜 안 되는지 알 수 없다.
                  문구는 연결 실패와 같은 표현 계층을 지난다. 원문은 title 로 남긴다 — 분류되지
                  않은 오류를 좇으려면 그것뿐이다. */}
              {status === 'error' && runtime?.message ? (
                <p
                  className="text-[0.7rem] leading-[1.45] text-[var(--danger-text)]"
                  title={runtime.message}
                >
                  {portForwardFailureMessage(runtime)}
                </p>
              ) : null}
            </div>
          );
        })}
        {/* 목록의 끝으로 둔다. 스크롤 밖에 고정하면 규칙이 한두 개일 때 빈 공간을 건너 바닥에
            붙어서, 목록과 무관한 패널 단위 동작처럼 읽혔다.

            추가는 빈 상태에만 두면 규칙이 하나 생기는 순간 사라지므로 여기에도 둔다.

            포트 화면으로 보내는 버튼은 두지 않는다. 시작·정지·편집·추가가 모두 여기서 되고,
            남은 것은 삭제와 DNS 오버라이드뿐이다 — 둘 다 자주 쓰지 않고, 삭제는 되돌릴 수 없어
            규칙 목록을 보면서 하는 편이 맞다. */}
        {hostId ? (
          <div className="px-2.5 pb-2 pt-1">
            <Button
              variant="secondary"
              size="sm"
              className="w-full"
              onClick={() =>
                openPortForwardEditor({ kind: 'create', transport: addTransport, hostId })
              }
            >
              {translate('sessionPanel.ports.add')}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * `127.0.0.1:9000 → db.internal:3306`.
 *
 * 대상 필드는 전송 방식마다 이름이 다르다(ssh 는 targetHost, aws-ssm 은 remoteHost). 대상을
 * 못 읽는 방식이면 어디로 가는지 대신 무엇을 거치는지를 적는다.
 */
function describeMapping(rule: {
  transport: string;
  bindAddress: string;
  bindPort: number;
  targetHost?: string | null;
  targetPort?: number | null;
  remoteHost?: string | null;
}): string {
  const bind = `${rule.bindAddress || '127.0.0.1'}:${rule.bindPort}`;
  const host = rule.targetHost ?? rule.remoteHost ?? null;
  if (rule.targetPort) {
    return `${bind} → ${host ? `${host}:${rule.targetPort}` : `:${rule.targetPort}`}`;
  }
  return `${bind} · ${rule.transport}`;
}
