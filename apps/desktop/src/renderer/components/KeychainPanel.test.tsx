import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostRecord, SecretMetadataRecord } from '@shared';
import { appStore } from '../store/appStore';
import { createEmptyVaultIndex } from '../store/utils';

// 비밀번호 복사는 preload 를 타므로 여기서는 부른 적 없다는 것만 보장한다.
const settingsService = vi.hoisted(() => ({
  copySavedCredentialPassword: vi.fn().mockResolvedValue(undefined),
  listTeamSavedCredentials: vi.fn(),
}));
vi.mock('../services/desktop/settings', () => settingsService);

beforeEach(() => {
  appStore.setState(appStore.getInitialState(), true);
});

const { KeychainPanel } = await import('./KeychainPanel');

function secret(overrides: Partial<SecretMetadataRecord>): SecretMetadataRecord {
  return {
    secretRef: 'secret:1',
    label: 'cred',
    hasPassword: true,
    hasPassphrase: false,
    hasManagedPrivateKey: false,
    hasCertificate: false,
    linkedHostCount: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as SecretMetadataRecord;
}

// secretRef·라벨에는 종류 이름을 넣지 않는다. 넣으면 검색 테스트가 그 문자열로 통과해서
// 배지가 검색어에 실린다는 사실을 증명하지 못한다.
const ENTRIES: SecretMetadataRecord[] = [
  secret({ secretRef: 'secret:aa11', label: 'bastion login', kind: 'ssh' }),
  secret({ secretRef: 'secret:bb22', label: 'win admin', kind: 'rdp' }),
  secret({ secretRef: 'secret:cc33', label: 'lab console', kind: 'vnc' }),
  // 이 필드가 생기기 전에 만든 항목. SSH 로 본다.
  secret({ secretRef: 'secret:dd44', label: 'old cred', kind: null }),
];

function renderPanel(
  entries: SecretMetadataRecord[] = ENTRIES,
  searchQuery = '',
  hosts: HostRecord[] = [],
) {
  const onSearchQueryChange = vi.fn();
  render(
    <KeychainPanel
      entries={entries}
      hosts={hosts}
      searchQuery={searchQuery}
      onSearchQueryChange={onSearchQueryChange}
      onRemoveSecret={vi.fn().mockResolvedValue(undefined)}
      onEditSecret={vi.fn()}
      onGenerateSshKey={vi.fn().mockResolvedValue({} as never)}
      onCopySshPublicKey={vi.fn().mockResolvedValue(undefined)}
      onInstallSshPublicKey={vi.fn().mockResolvedValue({} as never)}
    />,
  );
  return { onSearchQueryChange };
}

/** 라벨이 속한 카드. 배지가 그 항목의 것인지 확인하려면 카드 단위로 봐야 한다. */
function cardOf(label: string): HTMLElement {
  const card = screen.getByText(label).closest('article, li, div[class*="rounded"]');
  if (!card) {
    throw new Error(`card not found for ${label}`);
  }
  return card as HTMLElement;
}

describe('KeychainPanel 자격증명 종류 표시', () => {
  // 비밀번호만 든 항목은 세 종류가 모두 'Password' 로 보였다 — 어느 프로토콜용인지 알 방법이 없었다.
  it('항목마다 프로토콜 배지를 붙인다', () => {
    renderPanel();

    expect(within(cardOf('bastion login')).getByText('SSH')).toBeInTheDocument();
    expect(within(cardOf('win admin')).getByText('RDP')).toBeInTheDocument();
    expect(within(cardOf('lab console')).getByText('VNC')).toBeInTheDocument();
    // 종류를 잃은 항목도 빈 배지가 아니라 SSH 로 나온다.
    expect(within(cardOf('old cred')).getByText('SSH')).toBeInTheDocument();
  });

  it('담긴 자격증명 설명은 그대로 남는다', () => {
    renderPanel();

    // 배지가 종류를 말하고 이 줄은 내용물을 말한다 — 둘 다 필요하다.
    expect(within(cardOf('win admin')).getByText('Password')).toBeInTheDocument();
  });

  // 목록이 길어지면 종류로 좁히는 것이 가장 빠르다.
  it('종류로 검색된다', () => {
    renderPanel(ENTRIES, 'vnc');

    expect(screen.getByText('lab console')).toBeInTheDocument();
    expect(screen.queryByText('win admin')).not.toBeInTheDocument();
    expect(screen.queryByText('bastion login')).not.toBeInTheDocument();
  });

  it('검색어가 라벨에도 계속 걸린다', () => {
    renderPanel(ENTRIES, 'admin');

    expect(screen.getByText('win admin')).toBeInTheDocument();
    expect(screen.queryByText('lab console')).not.toBeInTheDocument();
  });
});

// 설정의 볼트별 묶음(4-7). 팀 것은 함께 쓴다 — 바꾸거나 지우면 멤버 모두에게 간다(S1).
describe('KeychainPanel with team vaults', () => {
  const TEAM_ENTRY = secret({ secretRef: 'secret:team', label: 'acme db', kind: 'ssh', linkedHostCount: 2, hasManagedPrivateKey: true });
  const sshHost = (id: string, label: string) =>
    ({ id, kind: 'ssh', label, hostname: `${label}.example.com`, port: 22, username: 'ops', authType: 'agent' }) as unknown as HostRecord;

  function renderTeamPanel() {
    appStore.setState({
      vaultIndex: {
        ...createEmptyVaultIndex(),
        teams: [{ id: 'team-a', name: 'Acme Infra', role: 'owner', syncState: 'ready', syncError: null, groups: [] }],
        teamIdByHostId: { 'team-web': 'team-a' },
      },
    });
    settingsService.listTeamSavedCredentials.mockResolvedValue([TEAM_ENTRY]);
    const onEditSecret = vi.fn();
    const onRemoveSecret = vi.fn().mockResolvedValue(undefined);
    render(
      <KeychainPanel
        entries={[secret({ secretRef: 'secret:mine', label: 'my login', kind: 'ssh' })]}
        hosts={[sshHost('my-web', 'my-web'), sshHost('team-web', 'team-web')]}
        searchQuery=""
        onSearchQueryChange={vi.fn()}
        onRemoveSecret={onRemoveSecret}
        onEditSecret={onEditSecret}
        onGenerateSshKey={vi.fn().mockResolvedValue({} as never)}
        onCopySshPublicKey={vi.fn().mockResolvedValue(undefined)}
        onInstallSshPublicKey={vi.fn().mockResolvedValue({} as never)}
      />,
    );
    return { onEditSecret, onRemoveSecret };
  }
  const section = (vaultId: string) =>
    within(document.querySelector(`[data-vault-section="${vaultId}"]`)!.closest('section')!);

  it("lists a team's credentials under the team, with what changing them means in a hint", async () => {
    renderTeamPanel();

    await waitFor(() => expect(section('team-a').getByText('acme db')).toBeInTheDocument());
    expect(settingsService.listTeamSavedCredentials).toHaveBeenCalledWith('team-a');
    expect(section('personal').getByText('my login')).toBeInTheDocument();
    // 개인 묶음에는 말풍선이 없다.
    expect(section('personal').queryByRole('button', { name: '팀 자격 증명 설명' })).toBeNull();
    fireEvent.mouseEnter(section('team-a').getByRole('button', { name: '팀 자격 증명 설명' }).parentElement!);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Acme Infra 멤버가 함께 쓰는 비밀번호·키입니다');
    expect(screen.getByRole('tooltip')).toHaveTextContent('바꾸거나 지우면 멤버 모두에게 갑니다');
  });

  it('hands the team entry to edit and delete — the personal list does not have it', async () => {
    const { onEditSecret, onRemoveSecret } = renderTeamPanel();
    await waitFor(() => expect(section('team-a').getByText('acme db')).toBeInTheDocument());

    fireEvent.click(section('team-a').getByRole('button', { name: '편집' }));
    fireEvent.click(section('team-a').getByRole('button', { name: '삭제' }));
    expect(onEditSecret).toHaveBeenCalledWith('secret:team', TEAM_ENTRY);
    expect(onRemoveSecret).toHaveBeenCalledWith('secret:team', TEAM_ENTRY);

    // 개인 것은 지금처럼 참조만.
    fireEvent.click(section('personal').getByRole('button', { name: '편집' }));
    expect(onEditSecret).toHaveBeenLastCalledWith('secret:mine');
  });

  it("offers only the key's own vault hosts to install a team key on", async () => {
    renderTeamPanel();
    await waitFor(() => expect(section('team-a').getByText('acme db')).toBeInTheDocument());

    fireEvent.click(section('team-a').getByRole('button', { name: '호스트에 설치' }));

    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText('team-web')).toBeInTheDocument();
    expect(dialog.queryByText('my-web')).toBeNull();
  });
});

// 호스트를 지우다 중간에 끊기자 안 쓰는 인증 정보가 72개 남았다 — 하나씩 지우게 두지 않는다.
describe('KeychainPanel unused credentials', () => {
  const UNUSED = [
    secret({ secretRef: 'secret:a', label: 'old a', linkedHostCount: 0 }),
    secret({ secretRef: 'secret:b', label: 'old b', linkedHostCount: 0 }),
  ];
  const USED = secret({ secretRef: 'secret:used', label: 'still used', linkedHostCount: 2 });

  function renderWith(entries: SecretMetadataRecord[], searchQuery = '') {
    const onRemoveUnusedSecrets = vi.fn().mockResolvedValue(undefined);
    render(
      <KeychainPanel
        entries={entries}
        hosts={[]}
        searchQuery={searchQuery}
        onSearchQueryChange={vi.fn()}
        onRemoveSecret={vi.fn().mockResolvedValue(undefined)}
        onRemoveUnusedSecrets={onRemoveUnusedSecrets}
        onEditSecret={vi.fn()}
        onGenerateSshKey={vi.fn().mockResolvedValue({} as never)}
        onCopySshPublicKey={vi.fn().mockResolvedValue(undefined)}
        onInstallSshPublicKey={vi.fn().mockResolvedValue({} as never)}
      />,
    );
    return { onRemoveUnusedSecrets };
  }

  it('deletes the ones no host uses in one go, leaving the rest', () => {
    const { onRemoveUnusedSecrets } = renderWith([USED, ...UNUSED]);

    fireEvent.click(screen.getByRole('button', { name: '사용하지 않는 인증 정보 2개 삭제' }));

    expect(onRemoveUnusedSecrets).toHaveBeenCalledWith(UNUSED, null);
  });

  // 검색으로 가려도 센다 — 버튼에 적힌 수가 지울 수다.
  it('counts the ones a search hides too', () => {
    const { onRemoveUnusedSecrets } = renderWith([USED, ...UNUSED], 'still');

    fireEvent.click(screen.getByRole('button', { name: '사용하지 않는 인증 정보 2개 삭제' }));

    expect(onRemoveUnusedSecrets).toHaveBeenCalledWith(UNUSED, null);
  });

  it('does not offer it when every credential is in use', () => {
    renderWith([USED]);

    expect(screen.queryByRole('button', { name: /사용하지 않는 인증 정보/ })).toBeNull();
  });

  it('offers it per vault, with that vault only', async () => {
    appStore.setState({
      vaultIndex: {
        ...createEmptyVaultIndex(),
        teams: [{ id: 'team-a', name: 'Acme Infra', role: 'owner', syncState: 'ready', syncError: null, groups: [] }],
      },
    });
    const teamUnused = secret({ secretRef: 'secret:team-old', label: 'team old', linkedHostCount: 0 });
    settingsService.listTeamSavedCredentials.mockResolvedValue([teamUnused, secret({ secretRef: 'secret:team-used', label: 'team used' })]);
    const { onRemoveUnusedSecrets } = renderWith([USED, ...UNUSED]);
    const section = (vaultId: string) =>
      within(document.querySelector(`[data-vault-section="${vaultId}"]`)!.closest('section')!);

    await waitFor(() => expect(section('team-a').getByText('team old')).toBeInTheDocument());
    fireEvent.click(section('team-a').getByRole('button', { name: '사용하지 않는 인증 정보 1개 삭제' }));
    expect(onRemoveUnusedSecrets).toHaveBeenLastCalledWith([teamUnused], expect.objectContaining({ id: 'team-a', name: 'Acme Infra' }));

    fireEvent.click(section('personal').getByRole('button', { name: '사용하지 않는 인증 정보 2개 삭제' }));
    expect(onRemoveUnusedSecrets).toHaveBeenLastCalledWith(UNUSED, null);
  });

  it('counts the ones a search hides in a vault section too', async () => {
    appStore.setState({
      vaultIndex: {
        ...createEmptyVaultIndex(),
        teams: [{ id: 'team-a', name: 'Acme Infra', role: 'owner', syncState: 'ready', syncError: null, groups: [] }],
      },
    });
    settingsService.listTeamSavedCredentials.mockResolvedValue([]);
    const { onRemoveUnusedSecrets } = renderWith([USED, ...UNUSED], 'still');
    const personal = within(document.querySelector('[data-vault-section="personal"]')!.closest('section')!);

    await waitFor(() => expect(settingsService.listTeamSavedCredentials).toHaveBeenCalled());
    fireEvent.click(personal.getByRole('button', { name: '사용하지 않는 인증 정보 2개 삭제' }));

    expect(onRemoveUnusedSecrets).toHaveBeenCalledWith(UNUSED, null);
  });
});
