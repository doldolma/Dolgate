// 프로세스 섹션. **모니터링만** 한다 — 종료·우선순위 변경은 넣지 않는다. 확인 절차와 권한 실패
// 안내가 필요해 패널의 성격(보기)에서 벗어나고, 조작이 필요하면 터미널에서 하는 편이 예측
// 가능하다.
//
// 수집은 자원 섹션과 같은 왕복에 태운다(ps 를 그 명령 묶음에 추가). 검색은 받아 온 상위 N개를
// 앱에서 거르는 것이라 원격 왕복이 늘지 않는다.
//
// 정렬은 **CPU 내림차순 하나**다. 예전에는 CPU/MEM 토글을 뒀는데, 무엇을 볼지 고르게 하는 대신
// 두 값을 함께 보여 주면 고를 일이 없어진다 — 이 목록을 보는 이유는 대개 "무엇이 서버를 먹고
// 있나" 이고, 그때 두 값을 나란히 보는 것이 한 값으로 줄 세운 목록을 두 번 보는 것보다 빠르다.
//
// 그리는 방식은 **표**다. 값이 여러 열이고 줄마다 같은 자리를 읽는 데이터라, 카드처럼 두 줄로
// 쌓으면 숫자가 세로로 정렬되지 않아 훑기 어렵다(그렇게 두 줄로 뒀다가 되돌렸다). 사용자·메모리
// 크기는 열로 두면 340px 에서 명령 이름이 먼저 잘리므로 행의 title 로 남긴다.

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../lib/cn';
import { useAppStore } from '../../../store/appStore';
import { filterByQuery, splitProcessCommand } from '../../../lib/session-panel';
import { formatKibibytes, type HostProcess } from '../../../lib/host-metrics';
import { Button } from '../../../ui';
import { SessionPanelEmpty } from './SessionPanelEmpty';
import { SessionPanelSearch } from './SessionPanelSearch';
import { useSessionHostMetrics } from './useSessionHostMetrics';

interface SessionPanelProcessesProps {
  sessionId: string;
}

export function SessionPanelProcesses({ sessionId }: SessionPanelProcessesProps) {
  const { t: translate } = useTranslation();
  const enabled = useAppStore((state) => state.settings?.hostMetricsEnabled ?? false);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const { status, processes } = useSessionHostMetrics(sessionId, { processes: true });
  const [query, setQuery] = useState('');

  const rows = useMemo(() => {
    if (!processes) {
      return [];
    }
    const sorted = [...processes].sort(
      (left, right) => right.cpuPercent - left.cpuPercent,
    );
    return filterByQuery(
      sorted,
      query,
      (process) => `${process.command} ${process.user} ${process.pid}`,
    );
  }, [processes, query]);

  if (!enabled) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
        <SessionPanelEmpty
          title={translate('sessionPanel.resources.disabledTitle')}
          description={translate('sessionPanel.processes.disabled')}
        >
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void updateSettings({ hostMetricsEnabled: true });
            }}
          >
            {translate('sessionPanel.resources.enable')}
          </Button>
        </SessionPanelEmpty>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SessionPanelSearch
        value={query}
        onChange={setQuery}
        placeholder={translate('sessionPanel.processes.search')}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {processes === null ? (
          <SessionPanelEmpty
            title={
              status === 'unsupported'
                ? translate('sessionPanel.resources.unsupportedTitle')
                : translate('sessionPanel.processes.loadingTitle')
            }
            description={
              status === 'unsupported'
                ? undefined
                : translate('sessionPanel.processes.loading')
            }
          />
        ) : processes.length === 0 ? (
          // 명령은 돌았는데 한 줄도 없다 = busybox ps 처럼 옵션을 모르는 호스트다.
          <SessionPanelEmpty
            title={translate('sessionPanel.processes.unreadableTitle')}
            description={translate('sessionPanel.processes.unreadable')}
          />
        ) : rows.length === 0 ? (
          <SessionPanelEmpty
            title={translate('sessionPanel.history.noMatchesTitle')}
            description={translate('sessionPanel.processes.noMatches')}
          />
        ) : (
          <table className="w-full border-collapse text-[0.72rem]">
            <thead>
              {/* 스크롤해도 열 이름은 남는다 — 숫자만 보이면 어느 쪽이 CPU 인지 알 수 없다.
                  머리 아래 실선 하나로 값 영역과 갈라 준다(줄마다 선을 긋지는 않는다). */}
              <tr className="sticky top-0 z-[1] bg-[var(--surface)] text-[0.62rem] uppercase tracking-[0.08em] text-[var(--text-muted)]">
                <th className="w-[3rem] border-b border-[var(--border)] px-2 pb-1 pt-0.5 text-left font-medium">
                  PID
                </th>
                <th className="border-b border-[var(--border)] px-1 pb-1 pt-0.5 text-left font-medium">
                  {translate('sessionPanel.processes.columnCommand')}
                </th>
                <th className="w-[3.4rem] border-b border-[var(--border)] px-1 pb-1 pt-0.5 text-right font-medium">
                  CPU
                </th>
                <th className="w-[3.4rem] border-b border-[var(--border)] px-2 pb-1 pt-0.5 text-right font-medium">
                  RAM
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((process) => (
                <ProcessRow key={process.pid} process={process} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/** CPU 값에 색을 주는 문턱. 두 단계까지만 둔다 — 세 단계는 신호등이 되어 오히려 안 읽힌다. */
const CPU_WARN_PERCENT = 40;
const CPU_DANGER_PERCENT = 80;

function cpuToneClass(percent: number): string {
  if (percent >= CPU_DANGER_PERCENT) {
    return 'text-[var(--danger-text)]';
  }
  if (percent >= CPU_WARN_PERCENT) {
    return 'text-[var(--warning-text)]';
  }
  return 'text-[var(--text)]';
}

// 사용자와 메모리 크기는 열로 두면 좁은 패널에서 명령 이름을 먼저 잡아먹는다 — 행에 올려
// 두면 마우스만 올려도 보인다.
function ProcessRow({ process }: { process: HostProcess }) {
  const rss = process.rssKb === null ? null : formatKibibytes(process.rssKb);
  const { program, args } = splitProcessCommand(process.command);
  // CPU 를 행 배경의 채움으로도 보여 준다 — 숫자만 있으면 "많이 쓰는 놈" 을 찾으려고 값을
  // 하나씩 읽어야 한다. 멀티코어에서 %CPU 는 100 을 넘을 수 있어 잘라 쓴다.
  const fill = Math.min(100, Math.max(0, process.cpuPercent));
  return (
    <tr
      className="group transition-colors hover:bg-[var(--surface-muted)]"
      title={`${process.command}\n${rss ? `${process.user} · ${rss}` : process.user}`}
      style={{
        backgroundImage: `linear-gradient(to right, var(--selection-tint) ${fill}%, transparent ${fill}%)`,
      }}
    >
      <td className="px-2 py-1 align-baseline tabular-nums text-[var(--text-muted)]">
        {process.pid}
      </td>
      {/* max-w-0 이 있어야 표 안에서 truncate 가 듣는다(내용의 min-content 로 열이 벌어지지
          않게). 실제 폭은 나머지 열을 뺀 만큼 이 열이 받는다. */}
      <td className="max-w-0 px-1 py-1 align-baseline">
        <span className="block truncate">
          {/* 프로그램 이름과 인자를 색으로 가른다 — 목록에서 찾는 것은 늘 앞쪽이다. */}
          <span className="font-mono font-medium text-[var(--text)]">{program}</span>
          {args ? (
            <span className="font-mono text-[var(--text-soft)]"> {args}</span>
          ) : null}
        </span>
      </td>
      <td
        className={cn(
          'px-1 py-1 text-right align-baseline font-medium tabular-nums',
          cpuToneClass(process.cpuPercent),
        )}
      >
        {process.cpuPercent.toFixed(1)}%
      </td>
      <td className="px-2 py-1 text-right align-baseline tabular-nums text-[var(--text-soft)]">
        {process.memPercent.toFixed(1)}%
      </td>
    </tr>
  );
}
