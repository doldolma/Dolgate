import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TeamMember, VaultCopyCounts, VaultCopyRequest } from '@shared';
import { Button, SelectField, ToggleSwitch, Tooltip } from '../../ui';
import { ArrowRight, Info } from '../../ui/icons';
import type { BrowserVault } from '../host-browser/browserVaults';
import type { VaultCopyDraft } from '../host-browser/useHostBrowser';
import { TeamContentCountTiles } from './TeamContentCounts';
import { TeamDialogError, TeamDialogFrame } from './TeamDialogFrame';
import { useDialogAction } from './useDialogAction';

interface VaultCopyDialogProps {
  /** 개인과 이 기기의 팀들(buildBrowserVaults). */
  vaults: readonly BrowserVault[];
  draft: VaultCopyDraft;
  /** 호스트 이름 — 하나만 고르면 "어디서" 칸에 그 이름을 쓴다. */
  hostLabelOf: (hostId: string) => string | null;
  /** 워크스페이스 이름 — 하나만 고르면 "어디서" 칸에 그 이름을 쓴다. */
  workspaceLabelOf?: (workspaceId: string) => string | null;
  onPreview: (request: VaultCopyRequest) => Promise<VaultCopyCounts>;
  onListMembers: (teamId: string) => Promise<TeamMember[]>;
  onCopy: (request: VaultCopyRequest) => Promise<void>;
  onClose: () => void;
}

// 개수 칸 셋 말고 함께 오는 것 — 0 이 아닌 것만 한 줄로.
const EXTRA_KEYS = [
  'dependencyHosts',
  'knownHosts',
  'portForwards',
  'dnsOverrides',
  'snippets',
  'awsProfiles',
  'tailnets',
] as const;

const prettyPath = (path: string) => path.split('/').join(' / ');

/** 처음 대상 — 개인에서는 첫 팀, 팀에서는 개인. 막힌 팀은 고를 수 없다. */
function defaultTarget(vaults: readonly BrowserVault[], sourceVaultId: string): VaultCopyDraft['target'] {
  const candidates = vaults.filter((vault) => vault.id !== sourceVaultId && !vault.blocked);
  const source = vaults.find((vault) => vault.id === sourceVaultId);
  const preferredKind = source?.kind === 'personal' ? 'team' : 'personal';
  const vault = candidates.find((entry) => entry.kind === preferredKind) ?? candidates[0];
  return vault ? { vaultId: vault.id, groupPath: null } : null;
}

/** 어디서·어디로 칸 — 볼트 이름이 글에 들어 있어 볼트 표시는 달지 않는다. */
function LocationChip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex min-w-0 items-center rounded-[10px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-muted)_90%,transparent_10%)] px-3 py-2 text-[0.86rem] text-[var(--text)]">
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

/**
 * 볼트 사이 복사(공유) 확인 창(후보 D3). 놓은 자리가 있으면 그곳으로, 줄 메뉴에서 열면(대상 없음) 창 머리에서
 * 볼트·그룹을 고른다. 열 때와 대상을 바꿀 때 무엇이 몇 개 오는지 메인에 묻고(쓰지 않는다), 팀으로 갈 때는
 * 멤버 수를 읽는다(못 읽으면 그 말만 뺀다).
 */
export function VaultCopyDialog({
  vaults,
  draft,
  hostLabelOf,
  workspaceLabelOf,
  onPreview,
  onListMembers,
  onCopy,
  onClose,
}: VaultCopyDialogProps) {
  const { t: translate } = useTranslation();
  const { busy, error, run } = useDialogAction('teams.copy.failed');
  const [target, setTarget] = useState(() => draft.target ?? defaultTarget(vaults, draft.sourceVaultId));
  const [shareSecrets, setShareSecrets] = useState(true);
  const [preview, setPreview] = useState<{ key: string; counts: VaultCopyCounts | null; failed: boolean } | null>(null);
  const [members, setMembers] = useState<{ teamId: string; count: number } | null>(null);

  const source = vaults.find((vault) => vault.id === draft.sourceVaultId) ?? null;
  const targetVault = target ? (vaults.find((vault) => vault.id === target.vaultId) ?? null) : null;
  const toTeam = targetVault?.kind === 'team';
  const targetKey = target ? `${target.vaultId}\0${target.groupPath ?? ''}` : '';

  // 무엇이 몇 개 오는지 — 대상이 바뀔 때마다. 비밀번호 수는 함께 공유할 때의 수다(스위치 이름에 쓴다).
  useEffect(() => {
    if (!target) {
      return;
    }
    let cancelled = false;
    setPreview({ key: targetKey, counts: null, failed: false });
    void Promise.resolve()
      .then(() =>
        onPreview({
          sourceVaultId: draft.sourceVaultId,
          targetVaultId: target.vaultId,
          selection: draft.selection,
          targetGroupPath: target.groupPath,
        }),
      )
      .then(
        (counts) => {
          if (!cancelled) {
            setPreview({ key: targetKey, counts, failed: false });
          }
        },
        () => {
          if (!cancelled) {
            setPreview({ key: targetKey, counts: null, failed: true });
          }
        },
      );
    return () => {
      cancelled = true;
    };
  }, [draft.selection, draft.sourceVaultId, onPreview, target, targetKey]);

  const memberTeamId = toTeam && target ? target.vaultId : null;
  useEffect(() => {
    if (!memberTeamId) {
      return;
    }
    let cancelled = false;
    void Promise.resolve()
      .then(() => onListMembers(memberTeamId))
      .then(
        (list) => {
          if (!cancelled) {
            setMembers({ teamId: memberTeamId, count: list.length });
          }
        },
        () => undefined,
      );
    return () => {
      cancelled = true;
    };
  }, [memberTeamId, onListMembers]);

  const counts = preview?.key === targetKey ? preview.counts : null;
  const previewFailed = preview?.key === targetKey && preview.failed;
  const memberCount = memberTeamId && members?.teamId === memberTeamId ? members.count : null;
  const secrets = counts?.secrets ?? 0;
  const extras = counts
    ? EXTRA_KEYS.filter((key) => counts[key] > 0).map((key) =>
        translate(`teams.copy.extra.${key}`, { count: counts[key] }),
      )
    : [];

  const sourceName = source?.name ?? '';
  const targetName = targetVault?.name ?? '';
  const what =
    draft.selection.kind === 'groups'
      ? draft.selection.groupPaths.length === 1
        ? prettyPath(draft.selection.groupPaths[0]!)
        : translate('teams.copy.groupCount', { count: draft.selection.groupPaths.length })
      : draft.selection.kind === 'workspaces'
        ? draft.selection.workspaceIds.length === 1
          ? (workspaceLabelOf?.(draft.selection.workspaceIds[0]!) ?? translate('teams.copy.workspaceCount', { count: 1 }))
          : translate('teams.copy.workspaceCount', { count: draft.selection.workspaceIds.length })
        : draft.selection.hostIds.length === 1
          ? (hostLabelOf(draft.selection.hostIds[0]!) ?? translate('teams.copy.hostCount', { count: 1 }))
          : translate('teams.copy.hostCount', { count: draft.selection.hostIds.length });
  const shareLabel = translate('teams.copy.shareSecrets', { count: secrets });
  const footnote = [
    toTeam && memberCount !== null && memberCount > 1 ? translate('teams.copy.members', { count: memberCount }) : null,
    translate('teams.copy.keepsOriginal', { source: sourceName }),
    toTeam ? null : translate('teams.copy.onlyMe'),
  ]
    .filter(Boolean)
    .join(' ');

  const pickable = vaults.filter((vault) => vault.id !== draft.sourceVaultId && !vault.blocked);
  const pickableGroups = [...(targetVault?.groups ?? [])].sort((left, right) => left.path.localeCompare(right.path));
  // 로컬 창만 있는 워크스페이스는 호스트 없이도 복사할 것이 있다.
  const canCopy = Boolean(target && counts && counts.hosts + counts.groups + (counts.workspaces ?? 0) > 0 && !busy);

  const copy = () => {
    if (!target || !counts) {
      return;
    }
    const request: VaultCopyRequest = {
      sourceVaultId: draft.sourceVaultId,
      targetVaultId: target.vaultId,
      selection: draft.selection,
      targetGroupPath: target.groupPath,
      ...(toTeam ? { shareSecrets } : {}),
    };
    void run(() => onCopy(request)).then((done) => done && onClose());
  };

  return (
    <TeamDialogFrame
      section={toTeam ? 'Share' : 'Copy'}
      title={translate(toTeam ? 'teams.copy.shareTitle' : 'teams.copy.copyTitle', { target: targetName })}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {translate('common.cancel')}
          </Button>
          <Button variant="primary" disabled={!canCopy} onClick={copy}>
            {translate(toTeam ? 'teams.copy.share' : 'teams.copy.copy')}
          </Button>
        </>
      }
    >
      {draft.target === null ? (
        <div className="grid grid-cols-2 gap-3">
          <label className="grid gap-1.5">
            <span className="text-[0.78rem] text-[var(--text-soft)]">{translate('teams.copy.vault')}</span>
            <SelectField
              value={target?.vaultId ?? ''}
              onChange={(event) => setTarget({ vaultId: event.target.value, groupPath: null })}
            >
              {pickable.map((vault) => (
                <option key={vault.id} value={vault.id}>
                  {vault.name}
                </option>
              ))}
            </SelectField>
          </label>
          <label className="grid gap-1.5">
            <span className="text-[0.78rem] text-[var(--text-soft)]">{translate('teams.copy.group')}</span>
            <SelectField
              value={target?.groupPath ?? ''}
              onChange={(event) =>
                setTarget((current) => current && { ...current, groupPath: event.target.value || null })
              }
            >
              <option value="">{translate('teams.copy.root')}</option>
              {pickableGroups.map((group) => (
                <option key={group.path} value={group.path}>
                  {prettyPath(group.path)}
                </option>
              ))}
            </SelectField>
          </label>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2" data-vault-copy-route>
        <LocationChip>
          {sourceName} / {what}
        </LocationChip>
        <ArrowRight className="h-4 w-4 shrink-0 text-[var(--text-soft)]" aria-hidden />
        <LocationChip>
          {target?.groupPath ? (
            `${targetName} / ${prettyPath(target.groupPath)}`
          ) : (
            <>
              {targetName} <span className="text-[var(--text-soft)]">· {translate('teams.copy.root')}</span>
            </>
          )}
        </LocationChip>
      </div>
      <TeamContentCountTiles
        order={draft.selection.kind === 'workspaces' ? ['workspaces', 'hosts', 'secrets'] : ['hosts', 'groups', 'secrets']}
        counts={{
          workspaces: counts?.workspaces ?? null,
          hosts: counts?.hosts ?? null,
          groups: counts?.groups ?? null,
          // 팀에 비밀번호를 안 넣기로 하면 팀으로 가는 것은 0 이다(내 것은 내 자격 증명에 들어간다).
          secrets: counts ? (toTeam && !shareSecrets ? 0 : counts.secrets) : null,
        }}
      />
      {extras.length > 0 ? (
        <p className="m-0 text-sm text-[var(--text-soft)]">{translate('teams.copy.alongWith', { items: extras.join(' · ') })}</p>
      ) : null}
      {toTeam && secrets > 0 ? (
        <ToggleSwitch
          checked={shareSecrets}
          aria-label={shareLabel}
          label={
            <span className="inline-flex items-center gap-[0.3rem]">
              {shareLabel}
              <Tooltip label={translate('teams.copy.shareSecretsHint')} multiline>
                <Info className="h-4 w-4 text-[var(--text-soft)]" aria-hidden />
              </Tooltip>
            </span>
          }
          onClick={() => setShareSecrets((current) => !current)}
        />
      ) : null}
      <p className="m-0 text-sm text-[var(--text-soft)]">{footnote}</p>
      <TeamDialogError message={previewFailed ? translate('teams.copy.previewFailed') : null} />
      <TeamDialogError message={error} />
    </TeamDialogFrame>
  );
}
