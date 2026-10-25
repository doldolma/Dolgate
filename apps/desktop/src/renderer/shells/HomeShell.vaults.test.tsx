import { forwardRef, useEffect } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupRecord, HostDraft, HostRecord, SavedWorkspaceRecord, VaultIndex } from '@shared';

/**
 * 볼트가 **배관까지** 이어졌는지 — 홈 → 사이드바 → 스토어 → IPC.
 *
 * 사이드바·훅·스토어 시험은 각자 초록인데 홈이 볼트를 넘기지 않으면 팀 그룹이 개인에 쓰인다(4-2 에서 같은 일을 겪었다).
 * 그래서 여기서는 진짜 홈 뷰모델·사이드바·스토어를 목 API 위에서 그대로 돌린다.
 */

vi.mock('../store/appStore', async () =>
  (await import('../store/appStore.test-support')).createAppStoreModuleMock(),
);

let drawerProps: Record<string, unknown> = {};
// 렌더마다 받은 것 — 한 번이라도 다른 팀 목록을 받았는지 보려면 마지막 것만으로는 모자란다.
const drawerRenders: Array<Record<string, unknown>> = [];
// 서랍이 내려갔다 다시 뜨면 폼에 적어 둔 것이 사라진다 — 몇 번 떴는지 센다.
let drawerMounts = 0;
vi.mock('../components/HostDrawer', () => ({
  HostDrawer: forwardRef((props: Record<string, unknown>, _ref) => {
    drawerProps = props;
    drawerRenders.push(props);
    useEffect(() => {
      drawerMounts += 1;
    }, []);
    return <div data-testid="host-drawer" />;
  }),
}));

vi.mock('../view-models/settings', () => ({
  useSettingsViewModel: () =>
    stub({ keychainEntries: [{ secretRef: 'secret:mine', label: 'My key' }], activityLogs: [], settings: {} }),
}));

vi.mock('../services/desktop/tailnet', () => ({
  listTailnets: vi.fn().mockResolvedValue([{ id: 'my-tailnet', label: 'Home tailnet' }]),
  listTeamTailnets: vi.fn().mockResolvedValue([{ id: 'team-tailnet', label: 'Team tailnet' }]),
}));

import { appStore, desktopApi } from '../store/appStore';
import { listTailnets, listTeamTailnets } from '../services/desktop/tailnet';
import { createEmptyVaultIndex } from '../store/utils';
import { useHomeViewModel } from '../view-models/home';
import { HomeShell } from './HomeShell';
import { PortForwardEditorHost } from '../components/PortForwardEditorHost';

const TEAM = 'team-1';

function stub(overrides: Record<string, unknown>) {
  return new Proxy(overrides, {
    get: (target, key: string) => (key in target ? target[key] : vi.fn()),
  }) as never;
}

function host(id: string, groupName: string | null): HostRecord {
  return {
    id,
    kind: 'ssh',
    label: id,
    hostname: `${id}.example.test`,
    port: 22,
    username: 'ubuntu',
    authType: 'password',
    privateKeyPath: null,
    secretRef: null,
    groupName,
    tags: [],
    terminalThemeId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as HostRecord;
}

const group = (id: string, path: string) => ({ id, name: path, path, parentPath: null }) as GroupRecord;

function vaultIndex(): VaultIndex {
  return {
    ...createEmptyVaultIndex(),
    teams: [{ id: TEAM, name: 'Acme Infra', role: 'owner', syncState: 'ready', syncError: null, groups: [group('tg-prod', 'Prod')] }],
    teamIdByHostId: { 'team-web': TEAM },
  };
}

const requestSecretEditor = vi.fn();

function Home() {
  const homeViewModel = useHomeViewModel();
  return (
    <HomeShell
      active
      authState={stub({ status: 'authenticated', session: { user: { id: 'u1', email: 'dolma@acme.dev' } }, capabilities: {} })}
      offlineLeaseExpiryLabel={null}
      desktopPlatform="darwin"
      homeViewModel={homeViewModel}
      containersViewModel={stub({ tabs: [] })}
      modalViewModel={stub({ pendingInteractiveAuths: [] })}
      loginController={stub({})}
      onRequestLogin={vi.fn()}
      onRequestSecretEditor={requestSecretEditor}
    />
  );
}

beforeEach(() => {
  appStore.setState(appStore.getInitialState(), true);
  vi.clearAllMocks();
  drawerProps = {};
  drawerRenders.length = 0;
  drawerMounts = 0;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const hosts = [host('my-web', 'Prod'), host('team-web', 'Prod')];
  vi.mocked(desktopApi.hosts.list).mockResolvedValue(hosts);
  vi.mocked(desktopApi.groups.list).mockResolvedValue([group('pg-prod', 'Prod')]);
  vi.mocked(desktopApi.teams.getVaultIndex).mockResolvedValue(vaultIndex());
  appStore.setState({
    hosts,
    groups: [group('pg-prod', 'Prod')],
    vaultIndex: vaultIndex(),
    savedWorkspaces: [],
    homeSection: 'hosts',
  });
});

function createDataTransfer(): DataTransfer {
  const entries = new Map<string, string>();
  return {
    dropEffect: 'none',
    effectAllowed: 'all',
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    types: [],
    clearData: () => entries.clear(),
    getData: (format: string) => entries.get(format) ?? '',
    setData: (format: string, data: string) => entries.set(format, data),
    setDragImage: () => undefined,
  } as unknown as DataTransfer;
}

const tree = () => within(screen.getByLabelText('Group tree'));
const prodRows = () => tree().getAllByRole('button', { name: /^Prod(\s*\d+)?$/ });

describe('HomeShell vaults', () => {
  it('renames a team group in that team through the store and IPC', async () => {
    render(<Home />);

    // 개인 Prod 이 먼저, 팀 Prod 이 다음.
    fireEvent.contextMenu(prodRows()[1]!);
    fireEvent.click(screen.getByRole('button', { name: '이름 변경' }));
    fireEvent.change(screen.getByPlaceholderText('Group name'), { target: { value: 'Live' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename group' }));

    await waitFor(() => expect(desktopApi.groups.rename).toHaveBeenCalledWith('Prod', 'Live', TEAM));
  });

  it('goes into a team and creates a host there from the vault menu', async () => {
    vi.mocked(desktopApi.hosts.create).mockImplementation(
      async (draft) => ({ ...(draft as object), id: 'new-host' }) as HostRecord,
    );
    render(<Home />);
    const teamRow = screen.getByLabelText('Group tree').querySelector<HTMLElement>(`[data-vault-id="${TEAM}"]`)!;

    fireEvent.contextMenu(teamRow);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('button', { name: '새 호스트' }));

    expect(appStore.getState()).toMatchObject({ currentVaultId: TEAM, currentGroupPath: null });
    expect(appStore.getState().hostDrawer).toMatchObject({ mode: 'create', vaultId: TEAM });
    // 목록도 그 팀 것만 — 홈이 지금 볼트를 넘겨야 된다.
    expect(document.querySelector('[data-home-asset-key="host:team-web"]')).not.toBeNull();
    expect(document.querySelector('[data-home-asset-key="host:my-web"]')).toBeNull();
    expect(document.body.textContent).toContain('Acme Infra · 항목 1개');
    await waitFor(() => expect(screen.getByTestId('host-drawer')).toBeInTheDocument());

    const draft = {
      kind: 'ssh',
      label: 'bastion',
      hostname: 'bastion.acme.dev',
      port: 22,
      username: 'ops',
      authType: 'password',
      groupName: null,
      tags: [],
    } as unknown as HostDraft;
    await act(async () => {
      await (drawerProps.onSubmit as (draft: HostDraft) => Promise<void>)(draft);
    });
    // 만들기는 서랍이 연 볼트(팀)로 간다.
    expect(vi.mocked(desktopApi.hosts.create).mock.lastCall?.[2]).toBe(TEAM);
  });

  // 서랍 맨 위 Vault 로 만들 곳을 바꾼다. 고르기는 그 볼트 것으로 바뀌고, 그 팀 자격 증명을 읽는 동안에도 서랍은
  // 그대로다(내려갔다 뜨면 적어 둔 것이 사라진다). 만들기는 고른 볼트로 간다.
  it('moves the new host to the vault picked at the top of the drawer', async () => {
    vi.mocked(desktopApi.hosts.create).mockImplementation(
      async (draft) => ({ ...(draft as object), id: 'new-host' }) as HostRecord,
    );
    let resolveTeam: (entries: unknown) => void = () => undefined;
    vi.mocked(desktopApi.keychain.list).mockImplementation((vaultId?: string | null) =>
      vaultId === TEAM
        ? (new Promise((resolve) => {
            resolveTeam = resolve;
          }) as never)
        : (Promise.resolve([]) as never),
    );
    appStore.setState({ groups: [group('pg-prod', 'Prod'), group('pg-home', 'Home')] });
    render(<Home />);
    act(() => appStore.getState().navigateGroup('Home', 'personal'));
    act(() => appStore.getState().openCreateHostDrawer());
    await waitFor(() => expect(screen.getByTestId('host-drawer')).toBeInTheDocument());
    expect(drawerProps).toMatchObject({ mode: 'create', vaultId: null, defaultGroupPath: 'Home' });
    expect(drawerProps.vaultChoices).toEqual([
      { id: 'personal', team: null },
      { id: TEAM, team: { id: TEAM, name: 'Acme Infra' } },
    ]);

    act(() => (drawerProps.onVaultChange as (vaultId: string) => void)(TEAM));

    expect(drawerProps).toMatchObject({ vaultId: TEAM, defaultGroupPath: null });
    // 개인 자격 증명을 팀 서랍에 넘기지 않는다 — 다 읽기 전에는 빈 목록이다.
    expect(drawerProps.keychainEntries).toEqual([]);
    const values = (options: unknown) => (options as Array<{ value: string | null }>).map((option) => option.value);
    expect(values(drawerProps.groupOptions)).toEqual([null, 'Prod']);
    await waitFor(() => expect(desktopApi.keychain.list).toHaveBeenCalledWith(TEAM));
    await act(async () => resolveTeam([{ secretRef: 'secret:team', label: 'Team key' }]));
    expect(drawerProps.keychainEntries).toEqual([expect.objectContaining({ secretRef: 'secret:team' })]);
    await waitFor(() => expect(drawerProps.tailnetOptions).toEqual([{ id: 'team-tailnet', label: 'Team tailnet' }]));
    expect(drawerMounts).toBe(1);

    const draft = { kind: 'ssh', label: 'db', hostname: 'db.acme.dev', port: 22, username: 'ops', authType: 'password', groupName: '', tags: [] } as unknown as HostDraft;
    await act(async () => {
      await (drawerProps.onSubmit as (draft: HostDraft) => Promise<void>)(draft);
    });
    expect(vi.mocked(desktopApi.hosts.create).mock.lastCall?.[2]).toBe(TEAM);
    // 보고 있던 자리는 그대로다.
    expect(appStore.getState()).toMatchObject({ currentVaultId: 'personal', currentGroupPath: 'Home' });

    // 개인으로 되돌리면 개인에 만든다.
    act(() => appStore.getState().openCreateHostDrawer({ vaultId: TEAM, groupPath: null }));
    await waitFor(() => expect(screen.getByTestId('host-drawer')).toBeInTheDocument());
    act(() => (drawerProps.onVaultChange as (vaultId: string) => void)('personal'));
    expect(drawerProps.vaultId).toBeNull();
    await act(async () => {
      await (drawerProps.onSubmit as (draft: HostDraft) => Promise<void>)(draft);
    });
    expect(vi.mocked(desktopApi.hosts.create).mock.lastCall).toHaveLength(2);
  });

  it("doesn't offer a team you have to rejoin", async () => {
    const index = {
      ...vaultIndex(),
      teams: [
        ...vaultIndex().teams,
        { id: 'team-2', name: 'Beta Ops', role: 'member', syncState: 'needs-rejoin', syncError: null, groups: [] },
      ],
    } as VaultIndex;
    vi.mocked(desktopApi.teams.getVaultIndex).mockResolvedValue(index);
    appStore.setState({ vaultIndex: index });
    render(<Home />);

    act(() => appStore.getState().openCreateHostDrawer({ vaultId: 'personal', groupPath: null }));
    await waitFor(() => expect(screen.getByTestId('host-drawer')).toBeInTheDocument());

    expect((drawerProps.vaultChoices as Array<{ id: string }>).map((choice) => choice.id)).toEqual(['personal', TEAM]);
  });

  it('opens the team in settings from the vault menu', () => {
    render(<Home />);
    const teamRow = screen.getByLabelText('Group tree').querySelector<HTMLElement>(`[data-vault-id="${TEAM}"]`)!;

    fireEvent.contextMenu(teamRow);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('button', { name: '팀 관리' }));

    expect(appStore.getState().teamsPanelTeamId).toBe(TEAM);
  });

  it('quick-connects into the team you are in, and imports into your own vault', async () => {
    vi.mocked(desktopApi.hosts.create).mockImplementation(
      async (draft) => ({ ...(draft as object), id: 'quick-host' }) as HostRecord,
    );
    render(<Home />);
    // 팀 Prod 로 간다.
    fireEvent.click(prodRows()[1]!);
    expect(appStore.getState()).toMatchObject({ currentVaultId: TEAM, currentGroupPath: 'Prod' });

    // 빠른 연결로 만든 호스트는 그 팀에(지금 위치).
    act(() => appStore.setState({ searchQuery: 'ssh ops@bastion.acme.dev' }));
    const search = screen.getByRole('textbox', { name: /Search hosts inside/ });
    fireEvent.focus(search);
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() => expect(desktopApi.hosts.create).toHaveBeenCalled());
    expect(vi.mocked(desktopApi.hosts.create).mock.lastCall?.[0]).toMatchObject({ groupName: 'Prod' });
    expect(vi.mocked(desktopApi.hosts.create).mock.lastCall?.[2]).toBe(TEAM);

    // 가져오기는 비밀값까지 개인 볼트에 쓰는 길이라 팀 위치에서도 개인 맨 위(미분류)로 간다.
    act(() => appStore.setState({ searchQuery: '' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    const dialog = await screen.findByRole('dialog', { name: /OpenSSH/ });
    expect(dialog).toHaveTextContent('미분류');
    expect(dialog).not.toHaveTextContent('Prod');
  });

  it("narrows the host drawer's pickers to the vault of the host being edited", async () => {
    vi.mocked(desktopApi.keychain.list).mockImplementation(async (vaultId?: string | null) =>
      vaultId === TEAM ? ([{ secretRef: 'secret:team', label: 'Team key' }] as never) : ([] as never),
    );
    appStore.setState({
      groups: [group('pg-prod', 'Prod'), group('pg-home', 'Home')],
      snippets: [{ id: 'my-snippet', label: 'mine' } as never, { id: 'team-snippet', label: 'team' } as never],
      vaultIndex: { ...vaultIndex(), teamIdBySnippetId: { 'team-snippet': TEAM } },
    });
    render(<Home />);

    // 팀 호스트를 고치면 그 팀 것만.
    act(() => appStore.getState().openEditHostDrawer('team-web'));
    await waitFor(() =>
      expect(drawerProps.keychainEntries).toEqual([expect.objectContaining({ secretRef: 'secret:team' })]),
    );
    expect(desktopApi.keychain.list).toHaveBeenCalledWith(TEAM);
    await waitFor(() => expect(drawerProps.tailnetOptions).toEqual([{ id: 'team-tailnet', label: 'Team tailnet' }]));
    expect(listTeamTailnets).toHaveBeenCalledWith(TEAM);
    expect(drawerProps.vaultId).toBe(TEAM);
    // 폼 안의 tailnet 추가는 그 팀에 만든다(서랍의 vaultId 를 폼이 넘긴다 — 4-7).
    expect(typeof drawerProps.onTailnetAdded).toBe('function');
    const values = (options: unknown) => (options as Array<{ value: string | null }>).map((option) => option.value);
    expect(values(drawerProps.groupOptions)).not.toContain('Home');
    expect(values(drawerProps.jumpHostOptions)).not.toContain('my-web');
    expect((drawerProps.snippets as Array<{ id: string }>).map((snippet) => snippet.id)).toEqual(['team-snippet']);

    // 개인 호스트는 지금 그대로(스토어의 개인 목록, tailnet 추가 있음).
    act(() => appStore.getState().openEditHostDrawer('my-web'));
    await waitFor(() => expect(drawerProps.vaultId).toBeNull());
    expect(drawerProps.keychainEntries).toEqual([expect.objectContaining({ secretRef: 'secret:mine' })]);
    await waitFor(() => expect(drawerProps.tailnetOptions).toEqual([{ id: 'my-tailnet', label: 'Home tailnet' }]));
    expect(listTailnets).toHaveBeenCalled();
    expect(typeof drawerProps.onTailnetAdded).toBe('function');
    expect(typeof drawerProps.onEditExistingSecret).toBe('function');
    expect(values(drawerProps.groupOptions)).toContain('Home');
    expect(values(drawerProps.jumpHostOptions)).not.toContain('team-web');
    expect((drawerProps.snippets as Array<{ id: string }>).map((snippet) => snippet.id)).toEqual(['my-snippet']);
  });

  it("opens a team host's drawer only after that team's saved credentials are read", async () => {
    // 폼은 고른 자격 증명이 목록에 없으면 "새 자격 증명"으로 되돌린다. 빈 목록으로 먼저 뜨면 저장된 팀 비밀번호가
    // 풀린 채로 보이고, 그대로 저장하면 호스트에서 떨어진다(실제 앱에서 그랬다).
    let resolveTeam: (entries: unknown) => void = () => undefined;
    vi.mocked(desktopApi.keychain.list).mockImplementation((vaultId?: string | null) =>
      vaultId === TEAM
        ? (new Promise((resolve) => {
            resolveTeam = resolve;
          }) as never)
        : (Promise.resolve([]) as never),
    );
    render(<Home />);

    act(() => appStore.getState().openEditHostDrawer('team-web'));
    await waitFor(() => expect(desktopApi.keychain.list).toHaveBeenCalledWith(TEAM));
    expect(screen.queryByTestId('host-drawer')).toBeNull();

    await act(async () => resolveTeam([{ secretRef: 'secret:team', label: 'Team key' }]));
    expect(screen.getByTestId('host-drawer')).toBeInTheDocument();
    expect(drawerProps.keychainEntries).toEqual([expect.objectContaining({ secretRef: 'secret:team' })]);
    // 팀 자격 증명도 편집 창을 연다 — 메인이 그 볼트에서 읽고 고친다(4-7). 이름은 그 팀 목록에서 찾는다.
    act(() => (drawerProps.onEditExistingSecret as (secretRef: string) => void)('secret:team'));
    expect(requestSecretEditor).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'host', secretRef: 'secret:team', label: 'Team key', initialHostId: 'team-web' }),
    );
  });

  it("never hands one team's credentials to another team's drawer", async () => {
    const TEAM2 = 'team-2';
    const hosts = [host('my-web', 'Prod'), host('team-web', 'Prod'), host('beta-web', null)];
    const index = {
      ...vaultIndex(),
      teams: [
        ...vaultIndex().teams,
        { id: TEAM2, name: 'Beta Ops', role: 'member', syncState: 'ready', syncError: null, groups: [] },
      ],
      teamIdByHostId: { 'team-web': TEAM, 'beta-web': TEAM2 },
    } as VaultIndex;
    vi.mocked(desktopApi.hosts.list).mockResolvedValue(hosts);
    vi.mocked(desktopApi.teams.getVaultIndex).mockResolvedValue(index);
    appStore.setState({ hosts, vaultIndex: index });
    let resolveBeta: (entries: unknown) => void = () => undefined;
    vi.mocked(desktopApi.keychain.list).mockImplementation((vaultId?: string | null) =>
      vaultId === TEAM2
        ? (new Promise((resolve) => {
            resolveBeta = resolve;
          }) as never)
        : (Promise.resolve(vaultId === TEAM ? [{ secretRef: 'secret:team', label: 'Team key' }] : []) as never),
    );
    render(<Home />);
    act(() => appStore.getState().openEditHostDrawer('team-web'));
    await waitFor(() =>
      expect(drawerProps.keychainEntries).toEqual([expect.objectContaining({ secretRef: 'secret:team' })]),
    );

    // 서랍이 열린 채로 다른 팀 호스트로 넘어간다(편집 중 카드를 누를 때와 같다).
    act(() => appStore.getState().openEditHostDrawer('beta-web'));
    await waitFor(() => expect(desktopApi.keychain.list).toHaveBeenCalledWith(TEAM2));
    await act(async () => resolveBeta([{ secretRef: 'secret:beta', label: 'Beta key' }]));

    expect(drawerProps.keychainEntries).toEqual([expect.objectContaining({ secretRef: 'secret:beta' })]);
    const leaked = drawerRenders.some(
      (props) =>
        (props.host as HostRecord | null)?.id === 'beta-web' &&
        (props.keychainEntries as Array<{ secretRef: string }>).some((entry) => entry.secretRef === 'secret:team'),
    );
    expect(leaked).toBe(false);
  });

  it("reads the team's credentials again when a team host is saved, before the save settles", async () => {
    const events: string[] = [];
    let teamEntries = [{ secretRef: 'secret:team', label: 'Team key' }];
    vi.mocked(desktopApi.keychain.list).mockImplementation(async (vaultId?: string | null) => {
      if (vaultId === TEAM) {
        events.push('read team keys');
        return teamEntries as never;
      }
      return [] as never;
    });
    // 새 비밀번호를 넣으면 팀에 새 자격 증명이 생기고 호스트가 그것을 가리킨다.
    vi.mocked(desktopApi.hosts.update).mockImplementation(async (id, draft) => {
      teamEntries = [...teamEntries, { secretRef: 'secret:team-new', label: 'team-web' }];
      return { ...(draft as object), id, secretRef: 'secret:team-new' } as HostRecord;
    });
    render(<Home />);
    act(() => appStore.getState().openEditHostDrawer('team-web'));
    await waitFor(() => expect(screen.getByTestId('host-drawer')).toBeInTheDocument());

    await act(async () => {
      await (drawerProps.onSubmit as (draft: HostDraft, secrets?: unknown) => Promise<void>)(
        host('team-web', 'Prod') as unknown as HostDraft,
        { password: 'typed-in-form' },
      );
      events.push('save settled');
    });

    // 폼은 저장이 끝나면 호스트를 다시 채운다 — 그 전에 새 자격 증명이 든 목록이 와 있어야 한다.
    expect(events).toEqual(['read team keys', 'read team keys', 'save settled']);
    expect(drawerProps.keychainEntries).toEqual(
      expect.arrayContaining([expect.objectContaining({ secretRef: 'secret:team-new' })]),
    );
  });

  it('copies a personal host into the team from a drop, then shows the copy there', async () => {
    const counts = {
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
    };
    vi.mocked(desktopApi.teams.previewCopy).mockResolvedValue(counts);
    vi.mocked(desktopApi.teams.listMembers).mockResolvedValue([]);
    vi.mocked(desktopApi.teams.copy).mockImplementation(async () => {
      // 메인이 쓴 뒤의 목록 — 복사본은 팀 맨 위에 있다.
      vi.mocked(desktopApi.hosts.list).mockResolvedValue([
        host('my-web', 'Prod'),
        host('team-web', 'Prod'),
        { ...host('copy-1', null), label: 'my-web copy' } as HostRecord,
      ]);
      vi.mocked(desktopApi.teams.getVaultIndex).mockResolvedValue({
        ...vaultIndex(),
        teamIdByHostId: { 'team-web': TEAM, 'copy-1': TEAM },
      });
      return { hostIds: { 'my-web': 'copy-1' }, workspaceIds: {}, counts };
    });
    render(<Home />);

    const card = document.querySelector<HTMLElement>('[data-home-asset-key="host:my-web"]')!;
    const teamRow = screen.getByLabelText('Group tree').querySelector<HTMLElement>(`[data-vault-id="${TEAM}"]`)!;
    const dataTransfer = createDataTransfer();
    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.dragOver(teamRow, { dataTransfer });
    fireEvent.drop(teamRow, { dataTransfer });

    const dialog = await screen.findByRole('dialog', { name: 'Acme Infra 에 공유' });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: '공유' })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole('button', { name: '공유' }));

    await waitFor(() =>
      expect(desktopApi.teams.copy).toHaveBeenCalledWith({
        sourceVaultId: 'personal',
        targetVaultId: TEAM,
        selection: { kind: 'hosts', hostIds: ['my-web'] },
        targetGroupPath: null,
        shareSecrets: true,
      }),
    );
    // 복사본이 있는 곳 — 그 팀 맨 위로 가서 복사본을 고른다(다시 읽은 목록에 있다).
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Acme Infra 에 공유' })).toBeNull());
    expect(appStore.getState()).toMatchObject({ currentVaultId: TEAM, currentGroupPath: null });
    await waitFor(() =>
      expect(
        document.querySelector('[data-home-asset-key="host:copy-1"]')?.getAttribute('data-host-card-state'),
      ).toBe('selected'),
    );
    expect(document.querySelector('[data-home-asset-key="host:my-web"]')).toBeNull();
  });

  // 4-6: 워크스페이스도 팀 줄에 놓으면 복사한다(창의 호스트까지). 그 자리로만 가고 따라온 호스트는 고르지 않는다.
  it('copies a personal workspace into the team from a drop and goes there without picking a host', async () => {
    const workspace = {
      id: 'my-ws',
      version: 1,
      name: 'My Layout',
      root: {
        id: 'split',
        kind: 'split',
        axis: 'horizontal',
        ratio: 0.5,
        first: { id: 'l-web', kind: 'leaf', target: { kind: 'host', hostId: 'my-web', label: 'my-web' } },
        second: { id: 'l-local', kind: 'leaf', target: { kind: 'local', label: 'Local' } },
      },
      favorite: false,
      groupName: 'Prod',
      lastOpenedAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as SavedWorkspaceRecord;
    appStore.setState({ savedWorkspaces: [workspace] });
    const counts = {
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
      workspaces: 1,
    };
    vi.mocked(desktopApi.teams.previewCopy).mockResolvedValue(counts);
    vi.mocked(desktopApi.teams.listMembers).mockResolvedValue([]);
    vi.mocked(desktopApi.teams.copy).mockImplementation(async () => {
      vi.mocked(desktopApi.hosts.list).mockResolvedValue([
        host('my-web', 'Prod'),
        host('team-web', 'Prod'),
        { ...host('copy-1', null), label: 'my-web copy' } as HostRecord,
      ]);
      vi.mocked(desktopApi.teams.getVaultIndex).mockResolvedValue({
        ...vaultIndex(),
        teamIdByHostId: { 'team-web': TEAM, 'copy-1': TEAM },
      });
      return { hostIds: { 'my-web': 'copy-1' }, workspaceIds: { 'my-ws': 'ws-copy' }, counts };
    });
    render(<Home />);

    const card = document.querySelector<HTMLElement>('[data-home-asset-key="workspace:my-ws"]')!;
    const teamRow = screen.getByLabelText('Group tree').querySelector<HTMLElement>(`[data-vault-id="${TEAM}"]`)!;
    const dataTransfer = createDataTransfer();
    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.dragOver(teamRow, { dataTransfer });
    fireEvent.drop(teamRow, { dataTransfer });

    const dialog = await screen.findByRole('dialog', { name: 'Acme Infra 에 공유' });
    expect(dialog.querySelector('[data-vault-copy-route]')!.textContent).toContain('Personal / My Layout');
    await waitFor(() => expect(within(dialog).getByRole('button', { name: '공유' })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole('button', { name: '공유' }));

    await waitFor(() =>
      expect(desktopApi.teams.copy).toHaveBeenCalledWith(
        expect.objectContaining({ selection: { kind: 'workspaces', workspaceIds: ['my-ws'] }, targetVaultId: TEAM }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Acme Infra 에 공유' })).toBeNull());
    expect(appStore.getState()).toMatchObject({ currentVaultId: TEAM, currentGroupPath: null });
    await waitFor(() => expect(document.querySelector('[data-home-asset-key="host:copy-1"]')).not.toBeNull());
    expect(document.querySelector('[data-home-asset-key="host:copy-1"]')?.getAttribute('data-host-card-state')).not.toBe('selected');
  });

  it('goes to the copied group after copying a whole group', async () => {
    const counts = {
      groups: 1,
      hosts: 1,
      dependencyHosts: 0,
      secrets: 0,
      knownHosts: 0,
      portForwards: 0,
      dnsOverrides: 0,
      snippets: 0,
      awsProfiles: 0,
      tailnets: 0,
      workspaces: 0,
    };
    vi.mocked(desktopApi.teams.previewCopy).mockResolvedValue(counts);
    vi.mocked(desktopApi.teams.listMembers).mockResolvedValue([]);
    vi.mocked(desktopApi.teams.copy).mockResolvedValue({ hostIds: { 'my-web': 'copy-1' }, workspaceIds: {}, counts });
    render(<Home />);

    // 개인 Prod 그룹을 팀 Prod 에 놓으면 팀의 Prod/Prod 로 복사된다 — 거기로 간다.
    // 끌어 올리면 그 줄의 개수 자리가 "Copy" 로 바뀌어 이름이 달라진다 — 미리 잡아 둔다.
    const [personalProd, teamProd] = prodRows();
    const dataTransfer = createDataTransfer();
    fireEvent.dragStart(personalProd!, { dataTransfer });
    fireEvent.dragOver(teamProd!, { dataTransfer });
    fireEvent.drop(teamProd!, { dataTransfer });
    const dialog = await screen.findByRole('dialog', { name: 'Acme Infra 에 공유' });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: '공유' })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole('button', { name: '공유' }));

    await waitFor(() =>
      expect(desktopApi.teams.copy).toHaveBeenCalledWith(
        expect.objectContaining({ selection: { kind: 'groups', groupPaths: ['Prod'] }, targetGroupPath: 'Prod' }),
      ),
    );
    await waitFor(() => expect(appStore.getState()).toMatchObject({ currentVaultId: TEAM, currentGroupPath: 'Prod/Prod' }));
  });

  it('shares several selected groups from the menu and then shows where they went', async () => {
    const counts = {
      groups: 2,
      hosts: 2,
      dependencyHosts: 0,
      secrets: 0,
      knownHosts: 0,
      portForwards: 0,
      dnsOverrides: 0,
      snippets: 0,
      awsProfiles: 0,
      tailnets: 0,
      workspaces: 0,
    };
    vi.mocked(desktopApi.teams.previewCopy).mockResolvedValue(counts);
    vi.mocked(desktopApi.teams.listMembers).mockResolvedValue([]);
    vi.mocked(desktopApi.teams.copy).mockResolvedValue({
      hostIds: { 'my-web': 'copy-1', 'my-home': 'copy-2' },
      workspaceIds: {},
      counts,
    });
    const hosts = [host('my-web', 'Prod'), host('my-home', 'Home'), host('team-web', 'Prod')];
    appStore.setState({ hosts, groups: [group('pg-prod', 'Prod'), group('pg-home', 'Home')] });
    render(<Home />);

    const [personalProd] = prodRows();
    const home = tree().getByRole('button', { name: /^Home(\s*\d+)?$/ });
    fireEvent.click(personalProd!);
    fireEvent.click(home, { metaKey: true });
    fireEvent.contextMenu(home);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('button', { name: '공유…' }));

    const dialog = await screen.findByRole('dialog', { name: 'Acme Infra 에 공유' });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: '공유' })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole('button', { name: '공유' }));

    await waitFor(() =>
      expect(desktopApi.teams.copy).toHaveBeenCalledWith(
        expect.objectContaining({ selection: { kind: 'groups', groupPaths: ['Home', 'Prod'] }, targetGroupPath: null }),
      ),
    );
    // 여러 그룹은 놓은 자리(여기서는 팀 맨 위)로 간다 — 그룹마다 그 아래에 있다.
    await waitFor(() => expect(appStore.getState()).toMatchObject({ currentVaultId: TEAM, currentGroupPath: null }));
  });

  it('keeps my credentials for a team host from its detail card, and shows my name right away', async () => {
    const summary = {
      username: 'deploy',
      authType: null,
      domain: null,
      hasPassword: false,
      hasPrivateKey: false,
      hasCertificate: false,
      hasPassphrase: false,
    };
    vi.mocked(desktopApi.teams.getMyCredentials).mockResolvedValue(null);
    vi.mocked(desktopApi.teams.setMyCredentials).mockImplementation(async () => {
      // 메인이 쓴 뒤의 볼트 표 — 내 이름이 실린다.
      vi.mocked(desktopApi.teams.getVaultIndex).mockResolvedValue({
        ...vaultIndex(),
        myUsernameByHostId: { 'team-web': 'deploy' },
      });
      return summary;
    });
    render(<Home />);

    fireEvent.click(document.querySelector<HTMLElement>('[data-home-asset-key="host:team-web"]')!);
    const card = await screen.findByText('비어 있으면 팀 것으로 접속합니다.');
    fireEvent.click(within(card.closest('div')!.parentElement!).getByRole('button', { name: 'Add' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'team-web · 내 자격 증명' }));
    fireEvent.change(dialog.getByPlaceholderText('ubuntu (팀)'), { target: { value: 'deploy' } });
    fireEvent.click(dialog.getByRole('button', { name: '저장' }));

    await waitFor(() => expect(desktopApi.teams.setMyCredentials).toHaveBeenCalledWith('team-web', { username: 'deploy' }));
    // 저장 뒤 볼트 표를 다시 읽어 내 이름이 스토어에 있다(팔레트·SFTP 부제가 이것을 본다).
    await waitFor(() => expect(appStore.getState().vaultIndex?.myUsernameByHostId).toEqual({ 'team-web': 'deploy' }));
    expect(await screen.findByText('deploy')).toBeInTheDocument();

    // 팔레트 부제도 내 이름으로 — 홈이 볼트 표의 내 이름을 넘긴다.
    act(() => appStore.setState({ searchQuery: 'team-web' }));
    fireEvent.focus(screen.getByRole('textbox', { name: /Search hosts and Workspaces/ }));
    const option = screen.getAllByRole('option').find((entry) => entry.textContent?.startsWith('team-web'));
    expect(option?.textContent).toContain('deploy@team-web.example.test');
  });

  it('opens the invite link window for the team from the vault menu', async () => {
    vi.mocked(desktopApi.teams.createInvite).mockResolvedValue({
      code: 'abc',
      link: 'https://sync.acme.dev/invite/abc#v1.key',
      expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    } as never);
    render(<Home />);
    const teamRow = screen.getByLabelText('Group tree').querySelector<HTMLElement>(`[data-vault-id="${TEAM}"]`)!;

    fireEvent.contextMenu(teamRow);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('button', { name: '초대 링크' }));

    expect(await screen.findByRole('dialog', { name: /Acme Infra/ })).toBeInTheDocument();
  });
});

// 4-6 배관: 진짜 홈·스토어로 묶음의 + → 창 → IPC 인자 → 볼트 표 다시 읽기 → 그 묶음에 보인다.
describe('HomeShell vault sections', () => {
  const at = '2026-01-01T00:00:00.000Z';
  const sectionOf = (vaultId: string) =>
    document.querySelector<HTMLElement>(`[data-vault-section="${vaultId}"]`)!.parentElement!;

  it('creates a snippet in the team from its section and shows it there', async () => {
    appStore.setState({ homeSection: 'snippets', snippets: [] });
    const record = { id: 'snip-new', label: 'App logs', command: 'journalctl -u app', keyword: null, createdAt: at, updatedAt: at };
    vi.mocked(desktopApi.snippets.create).mockImplementation(async () => {
      vi.mocked(desktopApi.teams.getVaultIndex).mockResolvedValue({ ...vaultIndex(), teamIdBySnippetId: { 'snip-new': TEAM } });
      return record;
    });
    render(<Home />);

    fireEvent.click(within(sectionOf(TEAM)).getByRole('button', { name: 'Acme Infra에 스니펫 추가' }));
    // 이 셸 시험의 로그아웃 확인 창은 늘 열려 있다 — 창은 이름으로 찾는다.
    const dialog = screen.getByRole('dialog', { name: /새 스니펫/ });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Snippet label' }), { target: { value: 'App logs' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Snippet command' }), { target: { value: 'journalctl -u app' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '추가' }));

    await waitFor(() => expect(within(sectionOf(TEAM)).getByText('App logs')).toBeInTheDocument());
    expect(vi.mocked(desktopApi.snippets.create).mock.calls[0]).toEqual([
      { label: 'App logs', command: 'journalctl -u app', keyword: null },
      TEAM,
    ]);
    expect(within(sectionOf('personal')).queryByText('App logs')).toBeNull();
  });

  it('creates a port forward for a team host from its section and shows it there', async () => {
    appStore.setState({ homeSection: 'portForwarding', portForwards: [], dnsOverrides: [], portForwardRuntimes: [] });
    vi.mocked(desktopApi.portForwards.create).mockImplementation(async (draft) => {
      vi.mocked(desktopApi.teams.getVaultIndex).mockResolvedValue({ ...vaultIndex(), teamIdByPortForwardId: { 'rule-new': TEAM } });
      return { ...draft, id: 'rule-new', createdAt: at, updatedAt: at } as never;
    });
    render(
      <>
        <Home />
        <PortForwardEditorHost />
      </>,
    );

    fireEvent.click(within(sectionOf(TEAM)).getByRole('button', { name: 'Acme Infra에 SSH 포워딩 추가' }));
    const dialog = await screen.findByRole('dialog', { name: /SSH 포워딩 추가/ });
    // 그 팀의 호스트로 열린다.
    expect(within(dialog).getByRole('button', { name: '호스트' })).toHaveTextContent('team-web');
    fireEvent.change(within(dialog).getByLabelText('이름'), { target: { value: 'team app' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '저장' }));

    await waitFor(() => expect(within(sectionOf(TEAM)).getByText('team app')).toBeInTheDocument());
    expect(desktopApi.portForwards.create).toHaveBeenCalledWith(expect.objectContaining({ hostId: 'team-web', label: 'team app' }));
  });
  // 기록 화면 — 홈이 볼트 표의 팀을 넘겨야 Vault 를 고를 수 있고, 팀 녹화는 팀과 함께 열린다.
  it('shows a team\'s history in the logs screen and opens its recording from the team', async () => {
    vi.mocked(desktopApi.teams.listActivity).mockResolvedValue([
      {
        seq: 1,
        id: 'event-1',
        source: 'app',
        authorUserId: 'user-b',
        authorEmail: 'b@acme.dev',
        createdAt: '2026-10-21T01:00:00.000Z',
        receivedAt: '2026-10-21T01:00:00.000Z',
        activity: {
          v: 1,
          phase: 'end',
          record: {
            id: 'session:s1',
            level: 'info',
            category: 'session',
            kind: 'session-lifecycle',
            message: 'SSH',
            metadata: {
              sessionId: 's1',
              hostId: 'team-web',
              hostLabel: 'team-web',
              title: 'team-web',
              connectionKind: 'ssh',
              connectedAt: '2026-10-21T01:00:00.000Z',
              status: 'closed',
              recordingId: 'rec-1',
              hasReplay: true,
            },
            createdAt: '2026-10-21T01:00:00.000Z',
          },
        },
        memberChange: null,
        unreadable: null,
      },
    ]);
    vi.mocked(desktopApi.teams.getReplayStatuses).mockResolvedValue([
      { recordingId: 'rec-1', state: 'ended', authorEmail: 'b@acme.dev', segmentCount: 2 },
    ]);
    appStore.setState({ homeSection: 'logs' });
    render(<Home />);

    fireEvent.change(await screen.findByRole('combobox', { name: 'Vault' }), { target: { value: TEAM } });
    expect(await screen.findByText('b@acme.dev')).toBeInTheDocument();
    expect(desktopApi.teams.listActivity).toHaveBeenCalledWith(TEAM, { limit: 100 });
    fireEvent.click(await screen.findByRole('button', { name: 'Replay' }));
    expect(desktopApi.sessionReplays.open).toHaveBeenCalledWith('rec-1', TEAM);
  });
});
