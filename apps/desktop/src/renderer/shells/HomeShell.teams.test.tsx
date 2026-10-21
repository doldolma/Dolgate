import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HomeShell } from './HomeShell';

/**
 * Teams 탭이 실제로 열리는지 — 설정 화면이 팀을 쓸 수 있는지와 나(계정 id)를 받는지 본다.
 *
 * 설정 화면 시험은 props 를 직접 주므로, 홈이 그 값을 안 넘겨도 초록이다(그러면 Teams 탭이 영영 안 보인다).
 */

let settingsPanelProps: Record<string, unknown> = {};

vi.mock('../components/SettingsPanel', () => ({
  SettingsPanel: (props: Record<string, unknown>) => {
    settingsPanelProps = props;
    return <div data-testid="settings-panel" />;
  },
}));

vi.mock('../view-models/settings', () => ({
  useSettingsViewModel: () => stub({ keychainEntries: [], activityLogs: [], settings: {}, teamsAvailable: true }),
}));

vi.mock('../services/desktop/tailnet', () => ({
  listTailnets: vi.fn().mockResolvedValue([]),
}));

function stub(overrides: Record<string, unknown>) {
  return new Proxy(overrides, {
    get: (target, key: string) => (key in target ? target[key] : vi.fn()),
  }) as never;
}

describe('HomeShell settings', () => {
  it('tells the settings screen whether teams can be used, and who I am', () => {
    render(
      <HomeShell
        active
        authState={stub({
          status: 'authenticated',
          session: { user: { id: 'user-1', email: 'dolma@acme.dev' } },
          capabilities: {},
        })}
        offlineLeaseExpiryLabel={null}
        desktopPlatform="darwin"
        homeViewModel={stub({
          hosts: [],
          groups: [],
          snippets: [],
          portForwards: [],
          portForwardRuntimes: [],
          dnsOverrides: [],
          sessions: [],
          currentGroupPath: null,
          homeSection: 'settings',
          hostDrawer: { mode: 'closed' },
        })}
        containersViewModel={stub({ tabs: [] })}
        modalViewModel={stub({})}
        loginController={stub({})}
        onRequestLogin={vi.fn()}
        onRequestSecretEditor={vi.fn()}
      />,
    );

    expect(screen.getByTestId('settings-panel')).toBeInTheDocument();
    expect(settingsPanelProps).toMatchObject({
      teamsAvailable: true,
      currentUserId: 'user-1',
      currentUserEmail: 'dolma@acme.dev',
    });
  });
});
