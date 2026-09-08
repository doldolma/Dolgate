import type { HostRecord, SavedWorkspaceRecord } from "@shared";

export type HomeAssetKey = `host:${string}` | `workspace:${string}`;
export type HomeAssetRef =
  | { kind: "host"; id: string }
  | { kind: "workspace"; id: string };

export type HomeAsset =
  | {
      key: `host:${string}`;
      kind: "host";
      id: string;
      label: string;
      groupName: string | null;
      favorite: boolean;
      record: HostRecord;
    }
  | {
      key: `workspace:${string}`;
      kind: "workspace";
      id: string;
      label: string;
      groupName: string | null;
      favorite: boolean;
      record: SavedWorkspaceRecord;
    };

export function toHomeAssetKey(ref: HomeAssetRef): HomeAssetKey {
  return `${ref.kind}:${ref.id}` as HomeAssetKey;
}

export function parseHomeAssetKey(key: HomeAssetKey): HomeAssetRef {
  const separator = key.indexOf(":");
  return {
    kind: key.slice(0, separator) as HomeAssetRef["kind"],
    id: key.slice(separator + 1),
  } as HomeAssetRef;
}

export function buildHomeAssets(
  workspaces: readonly SavedWorkspaceRecord[],
  hosts: readonly HostRecord[],
): HomeAsset[] {
  return [
    ...workspaces.map(
      (workspace): HomeAsset => ({
        key: `workspace:${workspace.id}`,
        kind: "workspace",
        id: workspace.id,
        label: workspace.name,
        groupName: workspace.groupName?.trim() || null,
        favorite: workspace.favorite,
        record: workspace,
      }),
    ),
    ...hosts.map(
      (host): HomeAsset => ({
        key: `host:${host.id}`,
        kind: "host",
        id: host.id,
        label: host.label,
        groupName: host.groupName?.trim() || null,
        favorite: host.favorite === true,
        record: host,
      }),
    ),
  ];
}

export function partitionHomeAssetKeys(keys: readonly HomeAssetKey[]): {
  hostIds: string[];
  workspaceIds: string[];
} {
  const hostIds: string[] = [];
  const workspaceIds: string[] = [];
  for (const key of keys) {
    const ref = parseHomeAssetKey(key);
    if (ref.kind === "host") {
      hostIds.push(ref.id);
    } else {
      workspaceIds.push(ref.id);
    }
  }
  return { hostIds, workspaceIds };
}

/**
 * 받은 키를 화면 순서로 정렬한다. **버리지는 않는다.**
 *
 * 예전에는 보이는 목록과 교집합을 취했다. 그런데 그룹 컨텍스트 메뉴는 화면 범위를 넘어 하위 트리
 * 전체를 모아 넘기므로(getAssetKeysInGroupTrees), 다른 그룹에 들어가 있거나 검색·태그 필터가 걸려
 * 있으면 그 키들이 조용히 사라졌다 — 메뉴는 "3개 내보내기" 라고 세어 놓고 1개만 넘어갔고, 아무것도
 * 보이지 않으면 빈 배열이 넘어가 내보내기 대화상자가 열린 뒤 실패했다. 백업·이관 기능이 조용히
 * 일부만 처리하는 것은 실패보다 나쁘다.
 *
 * 화면에서 순서를 아는 것만 그 순서로 앞에 두고, 모르는 것은 받은 순서를 유지해 뒤에 붙인다.
 */
export function orderHomeAssetKeys(
  keys: readonly HomeAssetKey[],
  visibleAssets: readonly HomeAsset[],
): HomeAssetKey[] {
  const requested = new Set(keys);
  const ordered = visibleAssets
    .map((asset) => asset.key)
    .filter((key) => requested.has(key));
  if (ordered.length === requested.size) {
    return ordered;
  }
  const placed = new Set(ordered);
  const rest: HomeAssetKey[] = [];
  for (const key of keys) {
    if (placed.has(key)) {
      continue;
    }
    placed.add(key);
    rest.push(key);
  }
  return [...ordered, ...rest];
}

export function getHomeAssetRange(
  visibleAssets: readonly HomeAsset[],
  anchorKey: HomeAssetKey | null,
  targetKey: HomeAssetKey,
): HomeAssetKey[] {
  const orderedKeys = visibleAssets.map((asset) => asset.key);
  const targetIndex = orderedKeys.indexOf(targetKey);
  if (targetIndex < 0) {
    return [];
  }
  const anchorIndex = anchorKey ? orderedKeys.indexOf(anchorKey) : -1;
  if (anchorIndex < 0) {
    return [targetKey];
  }
  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  return orderedKeys.slice(start, end + 1);
}
