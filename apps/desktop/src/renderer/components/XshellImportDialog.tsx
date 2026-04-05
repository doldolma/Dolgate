import { useEffect, useMemo, useState } from 'react';
import {
  isGroupWithinPath,
  normalizeGroupPath,
  type XshellImportGroupPreview,
  type XshellImportHostPreview,
  type XshellImportResult,
  type XshellImportWarning,
  type XshellProbeResult,
  type XshellSourceSummary
} from '@shared';
import { useXshellImportController } from '../controllers/useImportControllers';
import { DialogBackdrop } from './DialogBackdrop';
import {
  Button,
  EmptyState,
  FieldGroup,
  FilterRow,
  IconButton,
  Input,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalShell,
  NoticeCard,
  SectionLabel,
  StatusBadge,
} from '../ui';

interface XshellImportDialogProps {
  open: boolean;
  onClose: () => void;
  onImported: (result: XshellImportResult) => Promise<void> | void;
}

interface XshellSelectionState {
  selectedGroupPaths: string[];
  selectedHostKeys: string[];
}

interface VisibleSelectionTargets {
  groupPaths: string[];
  hostKeys: string[];
}

interface XshellTreeGroupNode {
  kind: 'group';
  id: string;
  path: string;
  name: string;
  parentPath: string | null;
  hostCount: number;
  matchesSelf: boolean;
  children: XshellTreeNode[];
  groupPathsInSubtree: string[];
  hostKeysInSubtree: string[];
}

interface XshellTreeHostNode {
  kind: 'host';
  id: string;
  host: XshellImportHostPreview;
  matchesSelf: boolean;
}

type XshellTreeNode = XshellTreeGroupNode | XshellTreeHostNode;

function normalizeQuery(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function buildAncestorGroupPaths(groupPath: string | null | undefined): string[] {
  const normalized = normalizeGroupPath(groupPath);
  if (!normalized) {
    return [];
  }

  const segments = normalized.split('/');
  const paths: string[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    paths.push(segments.slice(0, index + 1).join('/'));
  }
  return paths;
}

function matchesGroupQuery(group: Pick<XshellImportGroupPreview, 'name' | 'path'>, normalizedQuery: string): boolean {
  if (!normalizedQuery) {
    return true;
  }

  return [group.name, group.path].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
}

function matchesHostQuery(host: XshellImportHostPreview, normalizedQuery: string): boolean {
  if (!normalizedQuery) {
    return true;
  }

  return [host.label, host.hostname, host.username, host.groupPath ?? '', host.privateKeyPath ?? '', host.sourceFilePath]
    .join(' ')
    .toLocaleLowerCase()
    .includes(normalizedQuery);
}

function compareGroups(left: XshellImportGroupPreview, right: XshellImportGroupPreview): number {
  const nameCompare = left.name.localeCompare(right.name);
  if (nameCompare !== 0) {
    return nameCompare;
  }
  return left.path.localeCompare(right.path);
}

function compareHosts(left: XshellImportHostPreview, right: XshellImportHostPreview): number {
  const labelCompare = left.label.localeCompare(right.label);
  if (labelCompare !== 0) {
    return labelCompare;
  }
  return left.hostname.localeCompare(right.hostname);
}

function buildVisibleGroupNode(
  group: XshellImportGroupPreview,
  childGroupPathsByParent: Map<string | null, string[]>,
  groupsByPath: Map<string, XshellImportGroupPreview>,
  hostsByGroupPath: Map<string | null, XshellImportHostPreview[]>,
  normalizedQuery: string,
  forceVisible: boolean
): XshellTreeGroupNode | null {
  const matchesSelf = matchesGroupQuery(group, normalizedQuery);
  const showWholeSubtree = forceVisible || matchesSelf;
  const childNodes: XshellTreeNode[] = [];

  for (const childGroupPath of childGroupPathsByParent.get(group.path) ?? []) {
    const childGroup = groupsByPath.get(childGroupPath);
    if (!childGroup) {
      continue;
    }

    const childNode = buildVisibleGroupNode(
      childGroup,
      childGroupPathsByParent,
      groupsByPath,
      hostsByGroupPath,
      normalizedQuery,
      showWholeSubtree
    );
    if (childNode) {
      childNodes.push(childNode);
    }
  }

  for (const host of hostsByGroupPath.get(group.path) ?? []) {
    const hostMatchesSelf = matchesHostQuery(host, normalizedQuery);
    if (!showWholeSubtree && !hostMatchesSelf) {
      continue;
    }

    childNodes.push({
      kind: 'host',
      id: `host:${host.key}`,
      host,
      matchesSelf: hostMatchesSelf
    });
  }

  if (!showWholeSubtree && childNodes.length === 0) {
    return null;
  }

  const groupPathsInSubtree = [group.path];
  const hostKeysInSubtree: string[] = [];
  for (const childNode of childNodes) {
    if (childNode.kind === 'group') {
      groupPathsInSubtree.push(...childNode.groupPathsInSubtree);
      hostKeysInSubtree.push(...childNode.hostKeysInSubtree);
      continue;
    }
    hostKeysInSubtree.push(childNode.host.key);
  }

  return {
    kind: 'group',
    id: `group:${group.path}`,
    path: group.path,
    name: group.name,
    parentPath: group.parentPath ?? null,
    hostCount: group.hostCount,
    matchesSelf,
    children: childNodes,
    groupPathsInSubtree,
    hostKeysInSubtree
  };
}

export function buildXshellImportTree(
  groups: XshellImportGroupPreview[],
  hosts: XshellImportHostPreview[],
  query: string
): XshellTreeNode[] {
  const normalizedQuery = normalizeQuery(query);
  const groupsByPath = new Map<string, XshellImportGroupPreview>();

  for (const group of groups) {
    const normalizedPath = normalizeGroupPath(group.path);
    if (!normalizedPath) {
      continue;
    }

    groupsByPath.set(normalizedPath, {
      ...group,
      path: normalizedPath,
      parentPath: normalizeGroupPath(group.parentPath)
    });
  }

  for (const host of hosts) {
    for (const candidatePath of buildAncestorGroupPaths(host.groupPath)) {
      if (!groupsByPath.has(candidatePath)) {
        groupsByPath.set(candidatePath, {
          path: candidatePath,
          name: candidatePath.split('/').at(-1) ?? candidatePath,
          parentPath: candidatePath.includes('/') ? candidatePath.split('/').slice(0, -1).join('/') : null,
          hostCount: 0
        });
      }
    }
  }

  const childGroupPathsByParent = new Map<string | null, string[]>();
  for (const group of [...groupsByPath.values()].sort(compareGroups)) {
    const parentPath = normalizeGroupPath(group.parentPath);
    childGroupPathsByParent.set(parentPath, [...(childGroupPathsByParent.get(parentPath) ?? []), group.path]);
  }

  const hostsByGroupPath = new Map<string | null, XshellImportHostPreview[]>();
  for (const host of [...hosts].sort(compareHosts)) {
    const groupPath = normalizeGroupPath(host.groupPath);
    hostsByGroupPath.set(groupPath, [...(hostsByGroupPath.get(groupPath) ?? []), host]);
  }

  const treeNodes: XshellTreeNode[] = [];

  for (const rootGroupPath of childGroupPathsByParent.get(null) ?? []) {
    const group = groupsByPath.get(rootGroupPath);
    if (!group) {
      continue;
    }

    const node = buildVisibleGroupNode(group, childGroupPathsByParent, groupsByPath, hostsByGroupPath, normalizedQuery, false);
    if (node) {
      treeNodes.push(node);
    }
  }

  for (const host of hostsByGroupPath.get(null) ?? []) {
    const matchesSelf = matchesHostQuery(host, normalizedQuery);
    if (!matchesSelf) {
      continue;
    }

    treeNodes.push({
      kind: 'host',
      id: `host:${host.key}`,
      host,
      matchesSelf
    });
  }

  return treeNodes;
}

export function collectVisibleXshellSelectionTargets(nodes: XshellTreeNode[]): VisibleSelectionTargets {
  const groupPaths = new Set<string>();
  const hostKeys = new Set<string>();

  const visit = (node: XshellTreeNode) => {
    if (node.kind === 'group') {
      if (node.matchesSelf) {
        groupPaths.add(node.path);
        return;
      }

      for (const child of node.children) {
        visit(child);
      }
      return;
    }

    hostKeys.add(node.host.key);
  };

  for (const node of nodes) {
    visit(node);
  }

  return {
    groupPaths: [...groupPaths].sort((left, right) => left.localeCompare(right)),
    hostKeys: [...hostKeys].sort((left, right) => left.localeCompare(right))
  };
}

function normalizeXshellSelectionState(
  selection: XshellSelectionState,
  hosts: XshellImportHostPreview[]
): XshellSelectionState {
  const groupPathCandidates = [...new Set(selection.selectedGroupPaths.map((groupPath) => normalizeGroupPath(groupPath)).filter(Boolean))].sort(
    (left, right) => {
      const normalizedLeft = left as string;
      const normalizedRight = right as string;
      const depthCompare = normalizedLeft.split('/').length - normalizedRight.split('/').length;
      if (depthCompare !== 0) {
        return depthCompare;
      }
      return normalizedLeft.localeCompare(normalizedRight);
    }
  ) as string[];

  const normalizedGroupPaths: string[] = [];
  for (const groupPath of groupPathCandidates) {
    if (normalizedGroupPaths.some((candidate) => isGroupWithinPath(groupPath, candidate))) {
      continue;
    }
    normalizedGroupPaths.push(groupPath);
  }

  normalizedGroupPaths.sort((left, right) => {
    const depthCompare = left.split('/').length - right.split('/').length;
    if (depthCompare !== 0) {
      return depthCompare;
    }
    return left.localeCompare(right);
  });

  const hostByKey = new Map(hosts.map((host) => [host.key, host]));
  const normalizedHostKeys: string[] = [];
  for (const hostKey of selection.selectedHostKeys) {
    if (normalizedHostKeys.includes(hostKey)) {
      continue;
    }

    const host = hostByKey.get(hostKey);
    if (!host) {
      continue;
    }
    if (normalizedGroupPaths.some((groupPath) => isGroupWithinPath(host.groupPath ?? null, groupPath))) {
      continue;
    }

    normalizedHostKeys.push(hostKey);
  }

  return {
    selectedGroupPaths: normalizedGroupPaths,
    selectedHostKeys: normalizedHostKeys
  };
}

export function countEffectiveSelectedXshellHosts(
  hosts: XshellImportHostPreview[],
  selectedGroupPaths: string[],
  selectedHostKeys: string[]
): number {
  const selectedGroups = new Set(selectedGroupPaths.map((value) => value.trim()).filter(Boolean));
  const selectedHosts = new Set(selectedHostKeys);

  return hosts.filter((host) => {
    if (selectedHosts.has(host.key)) {
      return true;
    }
    return [...selectedGroups].some((groupPath) => isGroupWithinPath(host.groupPath ?? null, groupPath));
  }).length;
}

export function collectEffectiveSelectedXshellGroupPaths(
  groups: XshellImportGroupPreview[],
  hosts: XshellImportHostPreview[],
  selectedGroupPaths: string[],
  selectedHostKeys: string[]
): string[] {
  const resolvedPaths = new Set(
    selectedGroupPaths.map((groupPath) => normalizeGroupPath(groupPath)).filter((value): value is string => Boolean(value))
  );

  const normalizedGroupPreviews = groups
    .map((group) => normalizeGroupPath(group.path))
    .filter((value): value is string => Boolean(value));

  for (const selectedGroupPath of [...resolvedPaths]) {
    for (const candidateGroupPath of normalizedGroupPreviews) {
      if (isGroupWithinPath(candidateGroupPath, selectedGroupPath)) {
        resolvedPaths.add(candidateGroupPath);
      }
    }
  }

  const selectedHosts = new Set(selectedHostKeys);
  for (const host of hosts) {
    if (!selectedHosts.has(host.key) && ![...resolvedPaths].some((groupPath) => isGroupWithinPath(host.groupPath ?? null, groupPath))) {
      continue;
    }

    for (const ancestorGroupPath of buildAncestorGroupPaths(host.groupPath)) {
      resolvedPaths.add(ancestorGroupPath);
    }
  }

  return [...resolvedPaths].sort((left, right) => {
    const depthCompare = left.split('/').length - right.split('/').length;
    if (depthCompare !== 0) {
      return depthCompare;
    }
    return left.localeCompare(right);
  });
}

function renderWarningList(warnings: XshellImportWarning[]) {
  if (warnings.length === 0) {
    return null;
  }

  return (
    <div className="grid gap-2">
      {warnings.map((warning, index) => (
        <p
          key={`${warning.code ?? 'warning'}:${index}`}
          className="text-[0.9rem] leading-[1.6] text-[var(--text-soft)]"
        >
          {warning.message}
        </p>
      ))}
    </div>
  );
}

function renderSourceList(sources: XshellSourceSummary[]) {
  if (sources.length === 0) {
    return null;
  }

  return (
    <div className="grid gap-2">
      {sources.map((source) => (
        <p key={source.id} className="text-[0.9rem] leading-[1.6] text-[var(--text-soft)]">
          <strong>{source.origin === 'default-session-dir' ? '기본 경로' : '추가 폴더'}</strong> <code>{source.folderPath}</code>
        </p>
      ))}
    </div>
  );
}

interface XshellTreeRendererProps {
  nodes: XshellTreeNode[];
  expandedGroupPaths: Set<string>;
  searchQuery: string;
  selection: XshellSelectionState;
  onToggleExpanded: (groupPath: string) => void;
  onToggleGroup: (node: XshellTreeGroupNode, checked: boolean) => void;
  onToggleHost: (host: XshellImportHostPreview, checked: boolean) => void;
}

function XshellTreeRenderer({
  nodes,
  expandedGroupPaths,
  searchQuery,
  selection,
  onToggleExpanded,
  onToggleGroup,
  onToggleHost
}: XshellTreeRendererProps) {
  const selectedGroupPaths = useMemo(() => new Set(selection.selectedGroupPaths), [selection.selectedGroupPaths]);
  const selectedHostKeys = useMemo(() => new Set(selection.selectedHostKeys), [selection.selectedHostKeys]);

  const renderNode = (node: XshellTreeNode, depth: number, ancestorSelected: boolean) => {
    if (node.kind === 'host') {
      const inheritedSelection = ancestorSelected;
      const checked = inheritedSelection || selectedHostKeys.has(node.host.key);
      const disabled = inheritedSelection;

      return (
        <div key={node.id} className="grid gap-[0.45rem]">
          <div
            className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 rounded-[14px] border border-[var(--border)] bg-[var(--dialog-surface)] px-[0.8rem] py-[0.75rem]"
            style={{ paddingLeft: `${depth * 1.1}rem` }}
          >
            <span className="h-[1.8rem] w-[1.8rem] shrink-0" aria-hidden="true" />
            <label className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-3">
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={(event) => onToggleHost(node.host, event.target.checked)}
                aria-label={`${node.host.label} 호스트 선택`}
              />
              <div className="min-w-0">
                <strong>{node.host.label}</strong>
                <span className="block truncate text-[0.8rem] text-[var(--text-soft)]">
                  {node.host.username}@{node.host.hostname}:{node.host.port}
                </span>
                <small className="block truncate text-[0.8rem] text-[var(--text-soft)]">{node.host.groupPath ? node.host.groupPath : '루트 세션'}</small>
                <small className="block truncate text-[0.8rem] text-[var(--text-soft)]">{node.host.sourceFilePath}</small>
                {node.host.privateKeyPath ? <small className="block truncate text-[0.8rem] text-[var(--text-soft)]">{node.host.privateKeyPath}</small> : null}
              </div>
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge>{node.host.authType === 'privateKey' ? '개인 키' : '비밀번호'}</StatusBadge>
              {node.host.hasPasswordHint ? <StatusBadge>저장된 비밀번호</StatusBadge> : null}
              {node.host.hasAuthProfile ? <StatusBadge>인증 프로필</StatusBadge> : null}
            </div>
          </div>
        </div>
      );
    }

    const explicitlySelected = selectedGroupPaths.has(node.path);
    const inheritedSelection = ancestorSelected;
    const checked = inheritedSelection || explicitlySelected;
    const disabled = inheritedSelection;
    const hasAnySelectedDescendant =
      !checked &&
      (node.children.some((child) => {
        if (child.kind === 'group') {
          return selectedGroupPaths.has(child.path) || child.hostKeysInSubtree.some((hostKey) => selectedHostKeys.has(hostKey));
        }

        return selectedHostKeys.has(child.host.key);
      }) ||
        node.hostKeysInSubtree.some((hostKey) => selectedHostKeys.has(hostKey)));
    const isExpanded = Boolean(searchQuery) || expandedGroupPaths.has(node.path);

    return (
      <div key={node.id} className="grid gap-[0.45rem]">
        <div
          className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3 rounded-[14px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--dialog-surface)_80%,var(--accent-surface)_20%)] px-[0.8rem] py-[0.75rem]"
          style={{ paddingLeft: `${depth * 1.1}rem` }}
        >
          <button
            type="button"
            className={`inline-grid h-[1.8rem] w-[1.8rem] min-w-[1.8rem] place-items-center rounded-[10px] border border-[var(--border)] bg-[var(--dialog-surface)] text-[0.8rem] transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`}
            onClick={() => onToggleExpanded(node.path)}
            aria-label={`${node.name} 그룹 ${isExpanded ? '접기' : '펼치기'}`}
          >
            &gt;
          </button>
          <label className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-3">
            <input
              type="checkbox"
              checked={checked}
              disabled={disabled}
              ref={(element) => {
                if (element) {
                  element.indeterminate = hasAnySelectedDescendant;
                }
              }}
              onChange={(event) => onToggleGroup(node, event.target.checked)}
              aria-label={`${node.name} 그룹 선택`}
            />
            <div className="min-w-0">
              <strong>{node.name}</strong>
              <span className="block truncate text-[0.8rem] text-[var(--text-soft)]">{node.path}</span>
              <small className="block text-[0.8rem] text-[var(--text-soft)]">{node.hostCount > 0 ? `하위 호스트 ${node.hostCount}개` : '빈 그룹'}</small>
            </div>
          </label>
        </div>
        {isExpanded ? (
          <div className="grid gap-[0.45rem]">
            {node.children.length > 0 ? (
              node.children.map((child) => renderNode(child, depth + 1, checked))
            ) : (
              <div className="text-[0.9rem] leading-[1.6] text-[var(--text-soft)]" style={{ marginLeft: `${(depth + 1) * 1.1}rem` }}>
                이 그룹에는 가져올 호스트가 없습니다.
              </div>
            )}
          </div>
        ) : null}
      </div>
    );
  };

  return <>{nodes.map((node) => renderNode(node, 0, false))}</>;
}

export function XshellImportDialog({ open, onClose, onImported }: XshellImportDialogProps) {
  const {
    addXshellFolderToSnapshot,
    discardXshellSnapshot,
    importXshellSelection,
    pickXshellSessionFolder,
    probeXshellDefault,
  } = useXshellImportController();
  const [probe, setProbe] = useState<XshellProbeResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isAddingFolder, setIsAddingFolder] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedGroupPaths, setExpandedGroupPaths] = useState<string[]>([]);
  const [selection, setSelection] = useState<XshellSelectionState>({
    selectedGroupPaths: [],
    selectedHostKeys: []
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;
    setProbe(null);
    setSearchQuery('');
    setExpandedGroupPaths([]);
    setSelection({
      selectedGroupPaths: [],
      selectedHostKeys: []
    });
    setError(null);
    setIsLoading(true);

    void probeXshellDefault()
      .then((result) => {
        if (cancelled) {
          void discardXshellSnapshot(result.snapshotId);
          return;
        }
        setProbe(result);
      })
      .catch((loadError) => {
        if (cancelled) {
          return;
        }
        setError(loadError instanceof Error ? loadError.message : '로컬 Xshell 세션을 불러오지 못했습니다.');
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (open || !probe?.snapshotId) {
      return;
    }

    void discardXshellSnapshot(probe.snapshotId);
  }, [open, probe?.snapshotId]);

  useEffect(() => {
    setExpandedGroupPaths((probe?.groups ?? []).map((group) => group.path));
  }, [probe?.groups]);

  const treeNodes = useMemo(() => buildXshellImportTree(probe?.groups ?? [], probe?.hosts ?? [], searchQuery), [probe?.groups, probe?.hosts, searchQuery]);
  const visibleSelectionTargets = useMemo(() => collectVisibleXshellSelectionTargets(treeNodes), [treeNodes]);
  const effectiveSelectedHostCount = useMemo(
    () => countEffectiveSelectedXshellHosts(probe?.hosts ?? [], selection.selectedGroupPaths, selection.selectedHostKeys),
    [probe?.hosts, selection.selectedGroupPaths, selection.selectedHostKeys]
  );
  const effectiveSelectedGroupCount = useMemo(
    () =>
      collectEffectiveSelectedXshellGroupPaths(
        probe?.groups ?? [],
        probe?.hosts ?? [],
        selection.selectedGroupPaths,
        selection.selectedHostKeys
      ).length,
    [probe?.groups, probe?.hosts, selection.selectedGroupPaths, selection.selectedHostKeys]
  );
  const hasSavedPasswordHosts = useMemo(() => (probe?.hosts ?? []).some((host) => host.hasPasswordHint), [probe?.hosts]);
  const selectedItemCount = selection.selectedGroupPaths.length + selection.selectedHostKeys.length;
  const canImport = Boolean(probe?.snapshotId) && selectedItemCount > 0 && !isImporting;

  if (!open) {
    return null;
  }

  return (
    <DialogBackdrop onDismiss={onClose} dismissDisabled={isAddingFolder || isImporting}>
      <ModalShell role="dialog" aria-modal="true" aria-labelledby="xshell-import-title" size="xl">
        <ModalHeader>
          <div>
            <SectionLabel>Xshell</SectionLabel>
            <h3 id="xshell-import-title">Xshell 가져오기</h3>
          </div>
          <IconButton onClick={onClose} aria-label="Xshell 가져오기 대화상자 닫기">
            x
          </IconButton>
        </ModalHeader>

        <ModalBody className="grid gap-4">
          {isLoading ? (
            <NoticeCard tone="info">로컬 Xshell 세션을 읽는 중입니다.</NoticeCard>
          ) : null}
          {error ? (
            <NoticeCard tone="danger" role="alert">
              {error}
            </NoticeCard>
          ) : null}

          {probe ? renderSourceList(probe.sources) : null}
          {probe ? renderWarningList(probe.warnings) : null}
          {probe && hasSavedPasswordHosts ? <div className="text-[0.9rem] leading-[1.6] text-[var(--text-soft)]">암호화된 비밀번호는 복호화를 시도합니다. 실패하면 호스트만 추가됩니다.</div> : null}

          {probe ? (
            <>
              <FilterRow>
                <FieldGroup label="검색" className="flex-1">
                  <Input
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="그룹, 호스트, 사용자명, 경로 검색"
                    disabled={isLoading || isAddingFolder}
                  />
                </FieldGroup>

                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    variant="secondary"
                    disabled={isLoading || isAddingFolder}
                    onClick={async () => {
                      setError(null);
                      const folderPath = await pickXshellSessionFolder();
                      if (!folderPath || !probe.snapshotId) {
                        return;
                      }

                      setIsAddingFolder(true);
                      try {
                        const nextProbe = await addXshellFolderToSnapshot({
                          snapshotId: probe.snapshotId,
                          folderPath
                        });
                        setProbe(nextProbe);
                      } catch (loadError) {
                        setError(loadError instanceof Error ? loadError.message : '선택한 Xshell 세션 폴더를 추가하지 못했습니다.');
                      } finally {
                        setIsAddingFolder(false);
                      }
                    }}
                  >
                    {isAddingFolder ? '폴더를 불러오는 중...' : '세션 폴더 선택'}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setSelection((current) =>
                        normalizeXshellSelectionState(
                          {
                            selectedGroupPaths: [...current.selectedGroupPaths, ...visibleSelectionTargets.groupPaths],
                            selectedHostKeys: [...current.selectedHostKeys, ...visibleSelectionTargets.hostKeys]
                          },
                          probe.hosts
                        )
                      );
                    }}
                    disabled={visibleSelectionTargets.groupPaths.length === 0 && visibleSelectionTargets.hostKeys.length === 0}
                  >
                    보이는 항목 선택
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setSelection((current) =>
                        normalizeXshellSelectionState(
                          {
                            selectedGroupPaths: current.selectedGroupPaths.filter(
                              (groupPath) => !visibleSelectionTargets.groupPaths.includes(groupPath)
                            ),
                            selectedHostKeys: current.selectedHostKeys.filter(
                              (hostKey) => !visibleSelectionTargets.hostKeys.includes(hostKey)
                            )
                          },
                          probe.hosts
                        )
                      );
                    }}
                    disabled={selectedItemCount === 0}
                  >
                    보이는 항목 해제
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() =>
                      setSelection({
                        selectedGroupPaths: [],
                        selectedHostKeys: []
                      })
                    }
                    disabled={selectedItemCount === 0}
                  >
                    전체 선택 해제
                  </Button>
                </div>
              </FilterRow>

              <div className="flex flex-wrap items-center gap-3 text-[0.84rem] font-medium text-[var(--text-soft)]">
                <span>소스 {probe.sources.length}</span>
                <span>트리 항목 {probe.groups.length + probe.hosts.length}</span>
                <span>선택 항목 {selectedItemCount}</span>
                <span>가져올 호스트 {effectiveSelectedHostCount}</span>
                <span>생성될 그룹 {effectiveSelectedGroupCount}</span>
                {probe.skippedExistingHostCount > 0 ? <span>기존 중복 제외 {probe.skippedExistingHostCount}</span> : null}
                {probe.skippedDuplicateHostCount > 0 ? <span>세션 중복 제외 {probe.skippedDuplicateHostCount}</span> : null}
              </div>

              <div className="grid gap-[0.35rem]">
                <div className="text-[0.9rem] leading-[1.6] text-[var(--text-soft)]">호스트를 선택하면 필요한 상위 그룹은 자동 생성됩니다.</div>
                <div className="text-[0.9rem] leading-[1.6] text-[var(--text-soft)]">그룹을 선택하면 하위 그룹과 호스트를 모두 가져옵니다. 빈 그룹도 가져올 수 있습니다.</div>
              </div>

              <section className="grid min-h-0 gap-3">
                <h4>가져올 항목</h4>
                {treeNodes.length === 0 ? (
                  <EmptyState
                    title="현재 조건과 일치하는 Xshell 그룹이나 호스트가 없습니다."
                    description="다른 세션 폴더를 선택하거나 검색어를 바꿔보세요."
                  />
                ) : (
                  <div
                    className="flex min-h-0 flex-col gap-2 overflow-y-auto rounded-[18px] border border-[var(--border)] bg-[var(--dialog-surface-muted)] p-[0.45rem]"
                    role="tree"
                    aria-label="Xshell 가져오기 항목"
                  >
                    <XshellTreeRenderer
                      nodes={treeNodes}
                      expandedGroupPaths={new Set(expandedGroupPaths)}
                      searchQuery={searchQuery}
                      selection={selection}
                      onToggleExpanded={(groupPath) => {
                        setExpandedGroupPaths((current) =>
                          current.includes(groupPath)
                            ? current.filter((value) => value !== groupPath)
                            : [...current, groupPath]
                        );
                      }}
                      onToggleGroup={(node, checked) => {
                        setSelection((current) =>
                          normalizeXshellSelectionState(
                            checked
                              ? {
                                  selectedGroupPaths: [...current.selectedGroupPaths.filter((value) => !isGroupWithinPath(value, node.path)), node.path],
                                  selectedHostKeys: current.selectedHostKeys.filter((hostKey) => !node.hostKeysInSubtree.includes(hostKey))
                                }
                              : {
                                  selectedGroupPaths: current.selectedGroupPaths.filter((value) => value !== node.path),
                                  selectedHostKeys: current.selectedHostKeys
                                },
                            probe.hosts
                          )
                        );
                      }}
                      onToggleHost={(host, checked) => {
                        setSelection((current) =>
                          normalizeXshellSelectionState(
                            {
                              selectedGroupPaths: current.selectedGroupPaths,
                              selectedHostKeys: checked
                                ? [...current.selectedHostKeys, host.key]
                                : current.selectedHostKeys.filter((value) => value !== host.key)
                            },
                            probe.hosts
                          )
                        );
                      }}
                    />
                  </div>
                )}
              </section>
            </>
          ) : null}
        </ModalBody>

        <ModalFooter>
          <Button variant="secondary" onClick={onClose} disabled={isImporting}>
            취소
          </Button>
          <Button
            variant="primary"
            disabled={!canImport}
            onClick={async () => {
              if (!probe?.snapshotId) {
                return;
              }
              setError(null);
              setIsImporting(true);
              try {
                const result = await importXshellSelection({
                  snapshotId: probe.snapshotId,
                  selectedGroupPaths: selection.selectedGroupPaths,
                  selectedHostKeys: selection.selectedHostKeys
                });
                await onImported(result);
                onClose();
              } catch (importError) {
                setError(importError instanceof Error ? importError.message : 'Xshell 데이터를 가져오지 못했습니다.');
              } finally {
                setIsImporting(false);
              }
            }}
          >
            {isImporting ? '가져오는 중...' : '가져오기'}
          </Button>
        </ModalFooter>
      </ModalShell>
    </DialogBackdrop>
  );
}
