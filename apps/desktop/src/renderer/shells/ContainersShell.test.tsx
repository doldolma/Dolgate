import { useMemo, useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthState, HostRecord } from '@shared';
import { ContainersShell } from './ContainersShell';

vi.mock('../components/ContainersWorkspace', () => ({
  ContainersWorkspace: ({ host }: { host: HostRecord }) => (
    <div data-testid={`containers-workspace-${host.id}`} />
  ),
}));

vi.mock('../components/AwsEcsWorkspace', () => ({
  AwsEcsWorkspace: ({ host }: { host: HostRecord }) => (
    <div data-testid={`aws-ecs-workspace-${host.id}`} />
  ),
}));

vi.mock('./OfflineModeBanner', () => ({
  OfflineModeBanner: () => <div data-testid="offline-mode-banner" />,
}));

type HostTabRecord = {
  hostId: string;
  title: string;
  kind: 'host-containers' | 'ecs-cluster';
  runtime: 'docker' | 'podman' | null;
};

function createHost(hostId: string, label: string): HostRecord {
  return {
    id: hostId,
    kind: 'ssh',
    label,
    hostname: `${hostId}.example.test`,
    port: 22,
    username: 'ubuntu',
    authType: 'password',
    privateKeyPath: null,
    secretRef: null,
    groupName: null,
    tags: [],
    terminalThemeId: null,
    createdAt: '2026-04-10T00:00:00.000Z',
    updatedAt: '2026-04-10T00:00:00.000Z',
  };
}

function createHostTab(hostId: string, title: string): HostTabRecord {
  return {
    hostId,
    title,
    kind: 'host-containers',
    runtime: 'docker',
  };
}

interface ContainersShellHarnessProps {
  initialActiveHostId?: string;
  onCloseHostContainersTab?: ReturnType<typeof vi.fn>;
  onFocusHostContainersTab?: ReturnType<typeof vi.fn>;
}

function ContainersShellHarness({
  initialActiveHostId = 'host-1',
  onCloseHostContainersTab = vi.fn().mockResolvedValue(undefined),
  onFocusHostContainersTab = vi.fn(),
}: ContainersShellHarnessProps) {
  const hosts = useMemo(
    () => [
      createHost('host-1', 'Alpha'),
      createHost('host-2', 'Bravo'),
      createHost('host-3', 'Charlie'),
    ],
    [],
  );
  const tabs = useMemo(
    () => [
      createHostTab('host-1', 'Alpha · Containers'),
      createHostTab('host-2', 'Bravo · Containers'),
      createHostTab('host-3', 'Charlie · Containers'),
    ],
    [],
  );
  const [activeContainerHostId, setActiveContainerHostId] = useState(initialActiveHostId);

  const homeViewModel = {
    hosts,
  } as any;

  const containersViewModel = {
    containerTabs: tabs,
    activeContainerHostId,
    focusHostContainersTab: (hostId: string) => {
      onFocusHostContainersTab(hostId);
      setActiveContainerHostId(hostId);
    },
    closeHostContainersTab: onCloseHostContainersTab,
    reorderContainerTab: vi.fn(),
    refreshHostContainers: vi.fn(),
    refreshEcsClusterUtilization: vi.fn(),
    setEcsClusterSelectedService: vi.fn(),
    setEcsClusterActivePanel: vi.fn(),
    setEcsClusterTunnelState: vi.fn(),
    setEcsClusterLogsState: vi.fn(),
    openEcsExecShell: vi.fn(),
    selectHostContainer: vi.fn(),
    setHostContainersPanel: vi.fn(),
    setHostContainerTunnelState: vi.fn(),
    refreshHostContainerLogs: vi.fn(),
    loadMoreHostContainerLogs: vi.fn(),
    setHostContainerLogsFollow: vi.fn(),
    setHostContainerLogsSearchQuery: vi.fn(),
    searchHostContainerLogs: vi.fn(),
    clearHostContainerLogsSearch: vi.fn(),
    refreshHostContainerStats: vi.fn(),
    runHostContainerAction: vi.fn(),
    openHostContainerShell: vi.fn(),
  } as any;

  const modalViewModel = {
    pendingInteractiveAuth: null,
    respondInteractiveAuth: vi.fn(),
    reopenInteractiveAuthUrl: vi.fn(),
    clearPendingInteractiveAuth: vi.fn(),
  } as any;

  const loginController = {
    isRetryingOnline: false,
    retryOnline: vi.fn().mockResolvedValue(undefined),
  } as any;

  const authState = {
    status: 'authenticated',
    session: { userId: 'user-1' },
  } as unknown as AuthState & { session: NonNullable<AuthState['session']> };

  return (
    <ContainersShell
      active
      authState={authState}
      offlineLeaseExpiryLabel={null}
      homeViewModel={homeViewModel}
      containersViewModel={containersViewModel}
      modalViewModel={modalViewModel}
      loginController={loginController}
    />
  );
}

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
const originalRequestAnimationFrame = window.requestAnimationFrame;
const originalCancelAnimationFrame = window.cancelAnimationFrame;

afterEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: originalScrollIntoView,
  });
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    writable: true,
    value: originalRequestAnimationFrame,
  });
  Object.defineProperty(window, 'cancelAnimationFrame', {
    configurable: true,
    writable: true,
    value: originalCancelAnimationFrame,
  });
});

describe('ContainersShell', () => {
  it('scrolls the active host tab into view when selection changes', async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      writable: true,
      value: (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
    });
    Object.defineProperty(window, 'cancelAnimationFrame', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });

    render(<ContainersShellHarness />);
    scrollIntoView.mockClear();

    fireEvent.click(screen.getByRole('tab', { name: /bravo/i }));

    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalled();
    });
  });

  it('shows strip fades only while additional scroll area remains', async () => {
    render(<ContainersShellHarness />);

    const tabStrip = screen.getByRole('tablist', { name: 'Containers hosts' });
    let scrollLeft = 0;
    Object.defineProperty(tabStrip, 'clientWidth', {
      configurable: true,
      get: () => 180,
    });
    Object.defineProperty(tabStrip, 'scrollWidth', {
      configurable: true,
      get: () => 480,
    });
    Object.defineProperty(tabStrip, 'scrollLeft', {
      configurable: true,
      get: () => scrollLeft,
    });

    fireEvent.scroll(tabStrip);
    await waitFor(() => {
      expect(screen.queryByTestId('containers-host-tab-fade-left')).toBeNull();
      expect(screen.getByTestId('containers-host-tab-fade-right')).toBeInTheDocument();
    });

    scrollLeft = 120;
    fireEvent.scroll(tabStrip);
    await waitFor(() => {
      expect(screen.getByTestId('containers-host-tab-fade-left')).toBeInTheDocument();
      expect(screen.getByTestId('containers-host-tab-fade-right')).toBeInTheDocument();
    });

    scrollLeft = 300;
    fireEvent.scroll(tabStrip);
    await waitFor(() => {
      expect(screen.getByTestId('containers-host-tab-fade-left')).toBeInTheDocument();
      expect(screen.queryByTestId('containers-host-tab-fade-right')).toBeNull();
    });
  });

  it('supports keyboard tab navigation and links tabs to their active panel', async () => {
    const onFocusHostContainersTab = vi.fn();
    render(
      <ContainersShellHarness onFocusHostContainersTab={onFocusHostContainersTab} />,
    );

    const alphaTab = screen.getByRole('tab', { name: /alpha/i });
    const bravoTab = screen.getByRole('tab', { name: /bravo/i });
    const charlieTab = screen.getByRole('tab', { name: /charlie/i });

    expect(alphaTab).toHaveAttribute('tabindex', '0');
    expect(bravoTab).toHaveAttribute('tabindex', '-1');

    const activePanel = screen.getByRole('tabpanel');
    expect(alphaTab).toHaveAttribute('aria-controls', activePanel.id);
    expect(activePanel).toHaveAttribute('aria-labelledby', alphaTab.id);

    alphaTab.focus();
    fireEvent.keyDown(alphaTab, { key: 'ArrowRight' });
    await waitFor(() => {
      expect(onFocusHostContainersTab).toHaveBeenCalledWith('host-2');
      expect(bravoTab).toHaveAttribute('aria-selected', 'true');
      expect(document.activeElement).toBe(bravoTab);
    });

    fireEvent.keyDown(bravoTab, { key: 'End' });
    await waitFor(() => {
      expect(onFocusHostContainersTab).toHaveBeenCalledWith('host-3');
      expect(charlieTab).toHaveAttribute('aria-selected', 'true');
      expect(document.activeElement).toBe(charlieTab);
    });

    fireEvent.keyDown(charlieTab, { key: 'Home' });
    await waitFor(() => {
      expect(onFocusHostContainersTab).toHaveBeenCalledWith('host-1');
      expect(alphaTab).toHaveAttribute('aria-selected', 'true');
      expect(document.activeElement).toBe(alphaTab);
    });
  });

  it('keeps close button behavior separate from tab activation', async () => {
    const onCloseHostContainersTab = vi.fn().mockResolvedValue(undefined);
    const onFocusHostContainersTab = vi.fn();
    render(
      <ContainersShellHarness
        onCloseHostContainersTab={onCloseHostContainersTab}
        onFocusHostContainersTab={onFocusHostContainersTab}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Bravo 닫기' }));

    await waitFor(() => {
      expect(onCloseHostContainersTab).toHaveBeenCalledWith('host-2');
    });
    expect(onFocusHostContainersTab).not.toHaveBeenCalled();
  });
});
