import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS, type GroupRecord, type HostRecord, type VaultIndex } from '@shared';
import { createEmptyVaultIndex } from '../store/utils';

// SFTP 화면이 볼트를 고르기까지 넘기는지 — 셸 → SftpWorkspace → 스토어 동작. 고르기 시험은 props 를 직접 주므로,
// 셸이 볼트를 안 넘겨도 초록이다(그러면 같은 경로 폴더가 다시 합쳐진다).

vi.mock('../components/RemoteFileEditorModal', () => ({ RemoteFileEditorModal: () => null }));
vi.mock('../services/desktop/files', () => ({
  listLocalRoots: vi.fn().mockResolvedValue([{ label: '/', path: '/' }]),
  getPathForDroppedFile: vi.fn(),
}));

import { SftpShell } from './SftpShell';

const TEAM = 'team-1';

function stub(overrides: Record<string, unknown>) {
  return new Proxy(overrides, {
    get: (target, key: string) => (key in target ? target[key] : vi.fn()),
  }) as never;
}

const host = (id: string, groupName: string | null) =>
  ({ id, kind: 'ssh', label: id, hostname: `${id}.test`, port: 22, username: 'u', authType: 'password', groupName, tags: [] }) as unknown as HostRecord;
const group = (id: string, path: string) => ({ id, name: path, path, parentPath: null }) as GroupRecord;

function vaultIndex(): VaultIndex {
  return {
    ...createEmptyVaultIndex(),
    teams: [{ id: TEAM, name: 'Acme Infra', role: 'owner', syncState: 'ready', syncError: null, groups: [group('tg-prod', 'Prod')] }],
    teamIdByHostId: { 'team-web': TEAM },
  };
}

function pane(id: 'left' | 'right', sourceKind: 'local' | 'host') {
  return {
    id,
    sourceKind,
    endpoint: null,
    hostGroupPath: null,
    currentPath: sourceKind === 'local' ? '/left' : '',
    lastLocalPath: '',
    history: [],
    historyIndex: -1,
    entries: [],
    selectedPaths: [],
    selectionAnchorPath: null,
    filterQuery: '',
    selectedHostId: null,
    hostSearchQuery: '',
    isLoading: false,
    warningMessages: [],
  };
}

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SftpShell vaults', () => {
  it('hands the vaults to the host picker so it starts at vault folders', () => {
    const navigateSftpHostGroup = vi.fn();
    render(
      <SftpShell
        active
        authState={stub({ status: 'authenticated' })}
        offlineLeaseExpiryLabel={null}
        desktopPlatform="darwin"
        homeViewModel={stub({
          hosts: [host('my-web', 'Prod'), host('team-web', 'Prod')],
          groups: [group('pg-prod', 'Prod')],
          savedWorkspaces: [],
          vaultIndex: { ...vaultIndex(), myUsernameByHostId: { 'team-web': 'deploy' } },
        })}
        sftpViewModel={stub({
          sftpState: {
            localHomePath: '/Users/tester',
            leftPane: pane('left', 'local'),
            rightPane: pane('right', 'host'),
            transfers: [],
            pendingConflictDialog: null,
            terminalUploadEndpoints: {},
          },
          transfers: [],
          navigateSftpHostGroup,
        })}
        settingsViewModel={stub({ settings: { sftpBrowserColumnWidths: { ...DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS } } })}
        modalViewModel={stub({ pendingInteractiveAuths: [] })}
        loginController={stub({})}
      />,
    );

    const teamCard = document.querySelector<HTMLElement>(`[data-vault-card="${TEAM}"]`);
    expect(teamCard).not.toBeNull();
    // 볼트 표의 내 이름이 고르기 카드 부제까지 간다(팀 호스트 team-web 은 내 이름 deploy 로 붙는다).
    const picker = screen.getByLabelText('Available hosts for right pane');
    const teamHostCard = [...picker.querySelectorAll('article')].find(
      (card) => !card.hasAttribute('data-group-card') && card.textContent?.includes('team-web.test'),
    );
    expect(teamHostCard?.textContent).toContain('deploy@team-web.test');
    fireEvent.doubleClick(teamCard!);
    expect(navigateSftpHostGroup).toHaveBeenCalledWith('right', null, TEAM);
  });
});
