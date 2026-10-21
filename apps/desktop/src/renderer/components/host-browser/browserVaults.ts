import type {
  GroupRecord,
  HostRecord,
  SavedWorkspaceRecord,
  TeamRole,
  VaultIndex,
} from "@shared";
import { PERSONAL_VAULT_ID } from "../../store/utils";

/**
 * 사이드바 맨 윗단의 볼트 하나 — 그 볼트의 그룹·호스트·워크스페이스만 든다.
 *
 * 트리·목록은 볼트마다 이것만 넣어 지금 함수(경로 비교·정렬·빈 그룹 숨김)를 그대로 돌린다. 그래서 같은
 * 경로(`Prod`)가 개인과 팀에 다 있어도 섞이지 않는다.
 */
export interface BrowserVault {
  /** 개인은 PERSONAL_VAULT_ID, 팀은 팀 id. */
  id: string;
  kind: "personal" | "team";
  name: string;
  /** 팀에서 내 역할. 개인은 null. */
  role: TeamRole | null;
  /** 동기화가 막혀 손봐야 할 때만(다시 들어와야 함·업데이트 필요). 평소엔 null 이라 줄에 아무것도 안 보인다. */
  blocked: "needs-rejoin" | "outdated" | null;
  groups: GroupRecord[];
  hosts: HostRecord[];
  workspaces: SavedWorkspaceRecord[];
}

/**
 * 레코드를 볼트별로 나눈다. **팀이 없으면 빈 배열** — 화면은 볼트 줄 없이 지금처럼 그린다(정한 것 1).
 *
 * 볼트 표에 없는 레코드는 개인 것이다. 팀 그룹은 볼트 표에 팀마다 따로 온다(그룹 경로는 볼트 안에서만 유일하다).
 */
export function buildBrowserVaults(input: {
  hosts: readonly HostRecord[];
  groups: readonly GroupRecord[];
  savedWorkspaces: readonly SavedWorkspaceRecord[];
  vaultIndex: VaultIndex | null | undefined;
  personalName: string;
}): BrowserVault[] {
  const index = input.vaultIndex;
  if (!index?.teams?.length) {
    return [];
  }
  const personal: BrowserVault = {
    id: PERSONAL_VAULT_ID,
    kind: "personal",
    name: input.personalName,
    role: null,
    blocked: null,
    groups: [...input.groups],
    hosts: [],
    workspaces: [],
  };
  const teams = new Map<string, BrowserVault>(
    index.teams.map((team) => [
      team.id,
      {
        id: team.id,
        kind: "team",
        name: team.name,
        role: team.role,
        blocked:
          team.syncState === "needs-rejoin" || team.syncState === "outdated"
            ? team.syncState
            : null,
        groups: [...team.groups],
        hosts: [],
        workspaces: [],
      },
    ]),
  );
  const vaultOf = (teamId: string | undefined) =>
    (teamId ? teams.get(teamId) : undefined) ?? personal;
  for (const host of input.hosts) {
    vaultOf(index.teamIdByHostId[host.id]).hosts.push(host);
  }
  for (const workspace of input.savedWorkspaces) {
    vaultOf(index.teamIdByWorkspaceId[workspace.id]).workspaces.push(workspace);
  }
  return [personal, ...teams.values()];
}

/**
 * 볼트를 넘나드는 줄 상태(접기·끌어 놓을 자리)의 키.
 *
 * 개인은 경로 그대로다 — 팀이 생기기 전에 접어 둔 것이 그대로 이어지고, 팀이 없을 때의 코드 길이 바뀌지 않는다.
 * 팀은 앞에 "/" 를 붙여 구별한다. 다듬은 경로(normalizeGroupPath)는 "/" 로 시작하지 않으므로 개인 경로와 겹칠 수 없다.
 */
export function groupTreeKey(vaultId: string, path: string): string {
  return vaultId === PERSONAL_VAULT_ID ? path : `/${vaultId}\u0000${path}`;
}

/** 그 볼트의 키면 경로를, 아니면 null. */
export function pathOfGroupTreeKey(key: string, vaultId: string): string | null {
  if (vaultId === PERSONAL_VAULT_ID) {
    return key.startsWith("/") ? null : key;
  }
  const prefix = `/${vaultId}\u0000`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : null;
}
