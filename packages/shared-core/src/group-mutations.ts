import type { GroupRecord, GroupRemoveMode, HostRecord } from './models';
import {
  getGroupLabel,
  getParentGroupPath,
  isGroupWithinPath,
  normalizeGroupPath,
  rebaseGroupPath,
  stripRemovedGroupSegment
} from './group-paths';

// 그룹 트리를 바꾸는 순수 함수들.
//
// 데스크톱(Electron 메인)과 모바일이 **같은 것을 써야 한다.** 규칙이 눈에 잘 띄지 않는
// 것들이라 — 재부모화할 때 경로가 겹치면 버린다, 이름은 경로에서 다시 계산한다,
// 그룹 레코드가 없어도 호스트만으로 존재하는 그룹을 인정한다 — 두 벌이 되면 조용히
// 어긋난다. 같은 그룹을 폰에서 지운 것과 PC 에서 지운 것이 다른 결과를 낳는 식이다.
//
// 상태 저장소를 모른다. 다음 배열을 만들어 돌려줄 뿐이고, 저장·정렬·전송은 부르는 쪽이 한다.

export interface GroupMutationOptions {
  /** 지금 시각(ISO). 밖에서 받아야 테스트가 고정할 수 있다. */
  timestamp: string;
  /**
   * 바뀐 호스트를 저장 전에 손볼 기회.
   *
   * 데스크톱 메인은 자기 정규화(`normalizeIncomingHostRecord`)를 여기로 넘긴다. 그것까지
   * 여기로 가져오면 순수 함수가 데스크톱 저장 규칙에 묶인다.
   */
  normalizeHost?: (host: HostRecord) => HostRecord;
}

export interface GroupPathMutation {
  groups: GroupRecord[];
  hosts: HostRecord[];
  nextPath: string;
}

export interface GroupRemoval {
  groups: GroupRecord[];
  hosts: HostRecord[];
  removedGroupIds: string[];
  removedHostIds: string[];
}

/** 그룹 하나를 새로 만든다. 호스트는 건드리지 않는다(빈 그룹으로 시작한다). */
export function createGroupIn(
  groups: GroupRecord[],
  input: { id: string; name: string; parentPath?: string | null; timestamp: string }
): { groups: GroupRecord[]; created: GroupRecord } {
  const cleanedName = input.name.trim();
  if (!cleanedName) {
    throw new Error('Group name is required');
  }

  const normalizedParentPath = normalizeGroupPath(input.parentPath);
  const nextPath = normalizeGroupPath(
    normalizedParentPath ? `${normalizedParentPath}/${cleanedName}` : cleanedName
  );
  if (!nextPath) {
    throw new Error('Group path is invalid');
  }
  if (groups.some((record) => record.path === nextPath)) {
    throw new Error('Group already exists');
  }

  const created: GroupRecord = {
    id: input.id,
    name: cleanedName,
    path: nextPath,
    parentPath: normalizedParentPath,
    createdAt: input.timestamp,
    updatedAt: input.timestamp
  };
  return { groups: [...groups, created], created };
}

/**
 * 그룹 경로를 통째로 옮긴다. 이름 변경과 이동이 모두 이것이다 — 둘 다 "이 경로 아래를
 * 저 경로 아래로" 이고, 다른 것은 새 경로를 어떻게 구하느냐뿐이다.
 */
export function mutateGroupPathIn(
  groups: GroupRecord[],
  hosts: HostRecord[],
  targetPath: string,
  nextPath: string,
  options: GroupMutationOptions
): GroupPathMutation {
  const affectedGroups = groups.filter((record) => isGroupWithinPath(record.path, targetPath));
  const affectedHosts = hosts.filter((record) =>
    isGroupWithinPath(normalizeGroupPath(record.groupName), targetPath)
  );

  // 그룹 레코드가 없어도 호스트만으로 존재하는 그룹이 흔하다(호스트의 groupName 이 경로다).
  // 그래서 둘 중 하나라도 있으면 진행한다.
  if (affectedGroups.length === 0 && affectedHosts.length === 0) {
    throw new Error('Group not found');
  }

  const nextGroupsByPath = new Map<string, GroupRecord>();
  for (const record of groups) {
    if (!isGroupWithinPath(record.path, targetPath)) {
      nextGroupsByPath.set(record.path, record);
    }
  }
  if (nextGroupsByPath.has(nextPath)) {
    throw new Error('Group already exists');
  }

  for (const record of affectedGroups) {
    const rebasedPath = rebaseGroupPath(record.path, targetPath, nextPath);
    if (!rebasedPath) {
      throw new Error('Group path is invalid');
    }
    if (nextGroupsByPath.has(rebasedPath)) {
      throw new Error('Group already exists');
    }
    nextGroupsByPath.set(rebasedPath, {
      ...record,
      // 이름은 경로에서 다시 계산한다 — 옮기고 나면 마지막 마디가 곧 이름이다.
      name: getGroupLabel(rebasedPath),
      path: rebasedPath,
      parentPath: getParentGroupPath(rebasedPath),
      updatedAt: options.timestamp
    });
  }

  const normalizeHost = options.normalizeHost ?? ((host: HostRecord) => host);
  return {
    groups: [...nextGroupsByPath.values()],
    hosts: hosts.map((record) => {
      const hostGroupPath = normalizeGroupPath(record.groupName);
      if (!isGroupWithinPath(hostGroupPath, targetPath)) {
        return record;
      }
      return normalizeHost({
        ...record,
        groupName: rebaseGroupPath(hostGroupPath, targetPath, nextPath),
        updatedAt: options.timestamp
      });
    }),
    nextPath
  };
}

/** 이름 변경 — 부모는 그대로 두고 마지막 마디만 바꾼다. */
export function renameGroupIn(
  groups: GroupRecord[],
  hosts: HostRecord[],
  targetPath: string,
  name: string,
  options: GroupMutationOptions
): GroupPathMutation {
  const normalizedTargetPath = normalizeGroupPath(targetPath);
  if (!normalizedTargetPath) {
    throw new Error('Group path is invalid');
  }

  const cleanedName = name.trim();
  if (!cleanedName) {
    throw new Error('Group name is required');
  }

  const parentPath = getParentGroupPath(normalizedTargetPath);
  const nextPath = normalizeGroupPath(parentPath ? `${parentPath}/${cleanedName}` : cleanedName);
  if (!nextPath) {
    throw new Error('Group path is invalid');
  }
  if (nextPath === normalizedTargetPath) {
    throw new Error('Group path is unchanged');
  }

  return mutateGroupPathIn(groups, hosts, normalizedTargetPath, nextPath, options);
}

/** 이동 — 이름은 그대로 두고 부모만 바꾼다. */
export function moveGroupIn(
  groups: GroupRecord[],
  hosts: HostRecord[],
  targetPath: string,
  targetParentPath: string | null,
  options: GroupMutationOptions
): GroupPathMutation {
  const normalizedTargetPath = normalizeGroupPath(targetPath);
  if (!normalizedTargetPath) {
    throw new Error('Group path is invalid');
  }

  const normalizedTargetParentPath = normalizeGroupPath(targetParentPath);
  if (
    normalizedTargetParentPath &&
    isGroupWithinPath(normalizedTargetParentPath, normalizedTargetPath)
  ) {
    throw new Error('Group cannot be moved into itself or one of its descendants');
  }

  const label = getGroupLabel(normalizedTargetPath);
  const nextPath = normalizeGroupPath(
    normalizedTargetParentPath ? `${normalizedTargetParentPath}/${label}` : label
  );
  if (!nextPath) {
    throw new Error('Group path is invalid');
  }
  if (nextPath === normalizedTargetPath) {
    throw new Error('Group path is unchanged');
  }

  return mutateGroupPathIn(groups, hosts, normalizedTargetPath, nextPath, options);
}

/**
 * 그룹 삭제.
 *
 * - `delete-subtree`: 그 아래 그룹과 호스트를 통째로 지운다.
 * - `reparent-descendants`: 그 그룹만 빼고, 아래 것들을 한 단계 위로 끌어올린다.
 *   끌어올린 경로가 이미 있으면 그 그룹 레코드는 버린다(합쳐진다).
 */
export function removeGroupFrom(
  groups: GroupRecord[],
  hosts: HostRecord[],
  targetPath: string,
  mode: GroupRemoveMode,
  options: GroupMutationOptions
): GroupRemoval {
  const normalizedTargetPath = normalizeGroupPath(targetPath);
  if (!normalizedTargetPath) {
    throw new Error('Group path is invalid');
  }

  const affectedGroups = groups.filter((record) =>
    isGroupWithinPath(record.path, normalizedTargetPath)
  );
  const affectedHosts = hosts.filter((record) =>
    isGroupWithinPath(normalizeGroupPath(record.groupName), normalizedTargetPath)
  );

  if (affectedGroups.length === 0 && affectedHosts.length === 0) {
    throw new Error('Group not found');
  }

  if (mode === 'delete-subtree') {
    return {
      groups: groups.filter((record) => !isGroupWithinPath(record.path, normalizedTargetPath)),
      hosts: hosts.filter(
        (record) => !isGroupWithinPath(normalizeGroupPath(record.groupName), normalizedTargetPath)
      ),
      removedGroupIds: affectedGroups.map((record) => record.id),
      removedHostIds: affectedHosts.map((record) => record.id)
    };
  }

  const removedGroupIds: string[] = [];
  const nextGroupsByPath = new Map<string, GroupRecord>();
  for (const record of groups) {
    if (!isGroupWithinPath(record.path, normalizedTargetPath)) {
      nextGroupsByPath.set(record.path, record);
    }
  }

  for (const record of affectedGroups) {
    if (record.path === normalizedTargetPath) {
      removedGroupIds.push(record.id);
      continue;
    }
    const rebasedPath = stripRemovedGroupSegment(record.path, normalizedTargetPath);
    if (!rebasedPath || nextGroupsByPath.has(rebasedPath)) {
      // 올라간 자리에 이미 같은 경로가 있으면 이 레코드는 버린다 — 두 그룹이 합쳐진다.
      removedGroupIds.push(record.id);
      continue;
    }
    nextGroupsByPath.set(rebasedPath, {
      ...record,
      name: getGroupLabel(rebasedPath),
      path: rebasedPath,
      parentPath: getParentGroupPath(rebasedPath),
      updatedAt: options.timestamp
    });
  }

  const normalizeHost = options.normalizeHost ?? ((host: HostRecord) => host);
  return {
    groups: [...nextGroupsByPath.values()],
    hosts: hosts.map((record) => {
      const hostGroupPath = normalizeGroupPath(record.groupName);
      if (!isGroupWithinPath(hostGroupPath, normalizedTargetPath)) {
        return record;
      }
      return normalizeHost({
        ...record,
        groupName: stripRemovedGroupSegment(hostGroupPath, normalizedTargetPath),
        updatedAt: options.timestamp
      });
    }),
    removedGroupIds,
    // 재부모화는 호스트를 지우지 않는다.
    removedHostIds: []
  };
}
