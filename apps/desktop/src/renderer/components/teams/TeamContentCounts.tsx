import { useTranslation } from 'react-i18next';

/** 팀 창들이 보이는 종류별 개수. 따로 읽는 것은 읽는 동안 null 이다. */
export interface TeamContentCounts {
  groups: number | null;
  hosts: number | null;
  secrets: number | null;
  /** 공유 창에서 워크스페이스를 복사할 때만. */
  workspaces?: number | null;
}

type TeamContentKey = keyof TeamContentCounts;

const DEFAULT_ORDER: readonly TeamContentKey[] = ['groups', 'hosts', 'secrets'];

/** 개수 칸 셋(그룹·호스트·비밀번호와 키) — 팀 나가기·삭제 창과 공유 창이 같이 쓴다. */
export function TeamContentCountTiles({
  counts,
  order = DEFAULT_ORDER,
}: {
  counts: TeamContentCounts;
  order?: readonly TeamContentKey[];
}) {
  const { t: translate } = useTranslation();
  return (
    <div className="grid grid-cols-3 gap-2">
      {order.map((key) => (
        <div
          key={key}
          className="grid gap-0.5 rounded-[10px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-muted)_90%,transparent_10%)] px-3 py-2.5"
        >
          <strong className="text-[1.1rem] tabular-nums text-[var(--text)]">{counts[key] ?? '…'}</strong>
          <span className="text-[0.78rem] text-[var(--text-soft)]">{translate(`teamsPanel.counts.${key}`)}</span>
        </div>
      ))}
    </div>
  );
}
