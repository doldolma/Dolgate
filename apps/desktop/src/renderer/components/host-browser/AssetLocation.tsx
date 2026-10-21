import { Tooltip } from '../../ui';
import { TeamMark } from '../teams/TeamMark';

/** 섞인 목록에서 항목이 든 팀. 개인 것이거나 볼트가 섞이지 않은 목록이면 null 이다. */
export interface AssetTeam {
  id: string;
  name: string;
}

function joinGroupPath(group: string | null): string | null {
  return group ? group.split('/').join(' / ') : null;
}

/**
 * 카드 아래 줄의 위치(K2). 팀 것이면 "[머리글자] 팀 이름 / 그룹" — 목록 머리(Acme Infra / Prod)와 같은 문법이다.
 * 개인 것은 지금처럼 그룹만.
 */
export function CardLocation({
  team,
  group,
  ungroupedLabel,
}: {
  team: AssetTeam | null;
  group: string | null;
  ungroupedLabel: string;
}) {
  const path = joinGroupPath(group);
  if (!team) {
    return <span className="min-w-0 flex-1 truncate">{path ?? ungroupedLabel}</span>;
  }
  return (
    <span className="flex min-w-0 flex-1 items-center gap-[0.35rem]">
      <TeamMark name={team.name} size="xs" />
      <span className="min-w-0 truncate">{path ? `${team.name} / ${path}` : team.name}</span>
    </span>
  );
}

/**
 * 표 그룹 칸의 위치(T3). 칸이 좁아 팀은 머리글자 네모만 붙이고 팀 이름은 툴팁으로 — 경로가 잘리지 않게.
 */
export function TableLocation({ team, label }: { team: AssetTeam | null; label: string }) {
  if (!team) {
    return <span className="min-w-0 truncate text-[var(--text-soft)]">{label}</span>;
  }
  return (
    <span className="flex min-w-0 items-center gap-[0.35rem] text-[var(--text-soft)]">
      <Tooltip label={team.name} className="shrink-0">
        <TeamMark name={team.name} size="xs" />
      </Tooltip>
      <span className="sr-only">{team.name}</span>
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}
