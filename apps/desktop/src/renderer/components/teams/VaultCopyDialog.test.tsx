import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { GroupRecord, HostRecord, TeamMember, VaultCopyCounts, VaultIndex } from '@shared';
import { createEmptyVaultIndex } from '../../store/utils';
import { buildBrowserVaults } from '../host-browser/browserVaults';
import type { VaultCopyDraft } from '../host-browser/useHostBrowser';
import { VaultCopyDialog } from './VaultCopyDialog';

// 볼트 사이 복사(공유) 확인 창 — 어디서 → 어디로, 무엇이 몇 개, 비밀번호를 함께 줄지, 누가 보게 되는지.

const TEAM = 'team-1';
const BLOCKED = 'team-2';

const group = (id: string, path: string) =>
  ({ id, name: path.split('/').at(-1), path, parentPath: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null }) as GroupRecord;

function vaults() {
  const index: VaultIndex = {
    ...createEmptyVaultIndex(),
    // 막힌 팀이 먼저 — 처음 대상으로 막힌 팀을 고르지 않는지 본다.
    teams: [
      { id: BLOCKED, name: 'Ops Night', role: 'member', syncState: 'needs-rejoin', syncError: null, groups: [] },
      { id: TEAM, name: 'Acme Infra', role: 'owner', syncState: 'ready', syncError: null, groups: [group('tg-prod', 'Prod'), group('tg-web', 'Prod/web')] },
    ],
  };
  return buildBrowserVaults({
    hosts: [{ id: 'my-web', label: 'my-web', groupName: 'Prod' } as HostRecord],
    groups: [group('pg-prod', 'Prod')],
    savedWorkspaces: [],
    vaultIndex: index,
    personalName: 'Personal',
  });
}

function counts(overrides: Partial<VaultCopyCounts> = {}): VaultCopyCounts {
  return {
    groups: 0,
    hosts: 1,
    dependencyHosts: 0,
    secrets: 1,
    knownHosts: 0,
    portForwards: 0,
    dnsOverrides: 0,
    snippets: 0,
    awsProfiles: 0,
    tailnets: 0,
    workspaces: 0,
    ...overrides,
  };
}

const member = (userId: string) => ({ userId, email: `${userId}@acme.dev` }) as TeamMember;

function renderDialog(
  draft: VaultCopyDraft,
  options: { preview?: () => Promise<VaultCopyCounts>; members?: () => Promise<TeamMember[]> } = {},
) {
  const props = {
    onPreview: vi.fn(options.preview ?? (() => Promise.resolve(counts()))),
    onListMembers: vi.fn(options.members ?? (() => Promise.resolve([member('me'), member('kim'), member('lee')]))),
    onCopy: vi.fn().mockResolvedValue(undefined),
    onClose: vi.fn(),
  };
  render(
    <VaultCopyDialog
      vaults={vaults()}
      draft={draft}
      hostLabelOf={(hostId) => (hostId === 'my-web' ? 'my-web' : null)}
      workspaceLabelOf={(workspaceId) => (workspaceId === 'my-ws' ? 'My Layout' : null)}
      {...props}
    />,
  );
  return props;
}

const dialog = () => within(screen.getByRole('dialog'));
const hostsDraft: VaultCopyDraft = {
  sourceVaultId: 'personal',
  selection: { kind: 'hosts', hostIds: ['my-web'] },
  target: { vaultId: TEAM, groupPath: null },
};

describe('VaultCopyDialog', () => {
  it('says where it goes and what comes, shares with the secrets by default', async () => {
    const props = renderDialog(hostsDraft, {
      preview: () => Promise.resolve(counts({ dependencyHosts: 1, hosts: 2, portForwards: 2 })),
    });

    expect(dialog().getByRole('heading', { name: 'Acme Infra 에 공유' })).toBeInTheDocument();
    const route = document.querySelector('[data-vault-copy-route]')!;
    expect(route.textContent).toContain('Personal / my-web');
    expect(route.textContent).toContain('Acme Infra · 맨 위');
    await waitFor(() => expect(dialog().getByText('함께 오는 것: 점프·터널 호스트 1 · 포트 포워딩 2')).toBeInTheDocument());
    expect(dialog().getByRole('switch', { name: '비밀번호·SSH 키 1개도 함께 공유' })).toHaveAttribute('aria-checked', 'true');
    await waitFor(() =>
      expect(dialog().getByText('멤버 3명이 보고 쓸 수 있습니다. 원본은 Personal 에 그대로 남습니다.')).toBeInTheDocument(),
    );
    expect(props.onPreview).toHaveBeenCalledWith({
      sourceVaultId: 'personal',
      targetVaultId: TEAM,
      selection: hostsDraft.selection,
      targetGroupPath: null,
    });

    fireEvent.click(dialog().getByRole('button', { name: '공유' }));
    await waitFor(() =>
      expect(props.onCopy).toHaveBeenCalledWith({
        sourceVaultId: 'personal',
        targetVaultId: TEAM,
        selection: hostsDraft.selection,
        targetGroupPath: null,
        shareSecrets: true,
      }),
    );
    await waitFor(() => expect(props.onClose).toHaveBeenCalled());
  });

  it('puts no secrets in the team when the switch is off', async () => {
    const props = renderDialog(hostsDraft);

    const toggle = await dialog().findByRole('switch', { name: '비밀번호·SSH 키 1개도 함께 공유' });
    fireEvent.click(toggle);
    // 비밀번호와 키 칸은 팀으로 가는 수라 0 이 된다(내 것은 내 자격 증명에 들어간다).
    const secretsTile = dialog().getByText('비밀번호와 키').parentElement!;
    expect(secretsTile.textContent).toContain('0');
    fireEvent.click(dialog().getByRole('button', { name: '공유' }));
    await waitFor(() => expect(props.onCopy).toHaveBeenCalledWith(expect.objectContaining({ shareSecrets: false })));
  });

  it('copies team things to Personal without the switch or the member line', async () => {
    const props = renderDialog({
      sourceVaultId: TEAM,
      selection: { kind: 'group', groupPath: 'Prod/web' },
      target: { vaultId: 'personal', groupPath: 'Prod' },
    });

    expect(dialog().getByRole('heading', { name: 'Personal 로 복사' })).toBeInTheDocument();
    const route = document.querySelector('[data-vault-copy-route]')!;
    expect(route.textContent).toContain('Acme Infra / Prod / web');
    expect(route.textContent).toContain('Personal / Prod');
    await waitFor(() =>
      expect(dialog().getByText('원본은 Acme Infra 에 그대로 남습니다. 복사본은 나만 봅니다.')).toBeInTheDocument(),
    );
    expect(dialog().queryByRole('switch')).toBeNull();
    expect(props.onListMembers).not.toHaveBeenCalled();

    fireEvent.click(dialog().getByRole('button', { name: '복사' }));
    await waitFor(() =>
      expect(props.onCopy).toHaveBeenCalledWith({
        sourceVaultId: TEAM,
        targetVaultId: 'personal',
        selection: { kind: 'group', groupPath: 'Prod/web' },
        targetGroupPath: 'Prod',
      }),
    );
  });

  it('picks where to copy when opened from a menu', async () => {
    const props = renderDialog({ ...hostsDraft, target: null });

    // 개인에서 열면 첫 팀 맨 위가 골라져 있다. 막힌 팀과 자기 볼트는 고를 수 없다.
    const [vaultSelect, groupSelect] = dialog().getAllByRole('combobox') as HTMLSelectElement[];
    expect(vaultSelect!.value).toBe(TEAM);
    expect([...vaultSelect!.options].map((option) => option.textContent)).toEqual(['Acme Infra']);
    expect([...groupSelect!.options].map((option) => option.textContent)).toEqual(['맨 위', 'Prod', 'Prod / web']);
    await waitFor(() => expect(props.onPreview).toHaveBeenCalledWith(expect.objectContaining({ targetGroupPath: null })));

    fireEvent.change(groupSelect!, { target: { value: 'Prod/web' } });
    await waitFor(() =>
      expect(props.onPreview).toHaveBeenLastCalledWith(expect.objectContaining({ targetGroupPath: 'Prod/web' })),
    );
    expect(document.querySelector('[data-vault-copy-route]')!.textContent).toContain('Acme Infra / Prod / web');
    await waitFor(() => expect(dialog().getByRole('button', { name: '공유' })).toBeEnabled());
    fireEvent.click(dialog().getByRole('button', { name: '공유' }));
    await waitFor(() =>
      expect(props.onCopy).toHaveBeenCalledWith(expect.objectContaining({ targetVaultId: TEAM, targetGroupPath: 'Prod/web' })),
    );
  });

  it('opens without the member line when members cannot be read, and holds when the preview fails', async () => {
    renderDialog(hostsDraft, {
      members: () => Promise.reject(new Error('offline')),
      preview: () => Promise.reject(new Error('boom')),
    });

    expect(await dialog().findByText('무엇을 복사할지 읽지 못했습니다.')).toBeInTheDocument();
    expect(dialog().getByText('원본은 Personal 에 그대로 남습니다.')).toBeInTheDocument();
    expect(dialog().queryByText(/멤버/)).toBeNull();
    expect(dialog().getByRole('button', { name: '공유' })).toBeDisabled();
  });

  it('has no switch when there are no secrets, and cancel copies nothing', async () => {
    const props = renderDialog(hostsDraft, { preview: () => Promise.resolve(counts({ secrets: 0 })) });

    await waitFor(() => expect(dialog().getByRole('button', { name: '공유' })).toBeEnabled());
    expect(dialog().queryByRole('switch')).toBeNull();
    fireEvent.click(dialog().getByRole('button', { name: '취소' }));
    expect(props.onClose).toHaveBeenCalled();
    expect(props.onCopy).not.toHaveBeenCalled();
  });
});

// 4-6: 워크스페이스를 다른 볼트로 — 창의 호스트까지 함께 오고, 로컬 창만 있어도 복사할 수 있다.
describe('VaultCopyDialog workspaces', () => {
  const workspacesDraft: VaultCopyDraft = {
    sourceVaultId: 'personal',
    selection: { kind: 'workspaces', workspaceIds: ['my-ws'] },
    target: { vaultId: TEAM, groupPath: null },
  };

  it('names the workspace and counts workspaces first', async () => {
    renderDialog(workspacesDraft, { preview: () => Promise.resolve(counts({ workspaces: 1, hosts: 2, secrets: 1 })) });

    expect(document.querySelector('[data-vault-copy-route]')!.textContent).toContain('Personal / My Layout');
    await waitFor(() => expect(dialog().getByText('Workspace')).toBeInTheDocument());
    const tiles = [...document.querySelectorAll('.grid-cols-3 > div')].map((tile) => tile.textContent);
    expect(tiles).toEqual(['1Workspace', '2호스트', '1비밀번호와 키']);
  });

  it('copies a workspace of local panes only', async () => {
    const props = renderDialog(
      { ...workspacesDraft, selection: { kind: 'workspaces', workspaceIds: ['my-ws', 'other-ws'] } },
      { preview: () => Promise.resolve(counts({ workspaces: 2, hosts: 0, secrets: 0 })) },
    );

    expect(document.querySelector('[data-vault-copy-route]')!.textContent).toContain('Workspace 2개');
    await waitFor(() => expect(dialog().getByRole('button', { name: '공유' })).toBeEnabled());
    fireEvent.click(dialog().getByRole('button', { name: '공유' }));
    await waitFor(() =>
      expect(props.onCopy).toHaveBeenCalledWith(
        expect.objectContaining({ selection: { kind: 'workspaces', workspaceIds: ['my-ws', 'other-ws'] } }),
      ),
    );
  });
});
