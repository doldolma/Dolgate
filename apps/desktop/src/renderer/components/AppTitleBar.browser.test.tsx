import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { UpdateState } from '@shared';
import { AppTitleBar } from './AppTitleBar';

function createUpdateState(): UpdateState {
  return {
    enabled: true,
    status: 'idle',
    currentVersion: '1.0.0',
    release: null,
    progress: null,
    checkedAt: null,
    dismissedVersion: null,
    errorMessage: null
  };
}

function renderTitleBar(updateState: UpdateState = createUpdateState()) {
  return render(
    <AppTitleBar
      desktopPlatform="darwin"
      tabs={[]}
      workspaces={[]}
      tabStrip={[]}
      activeWorkspaceTab="home"
      draggedSession={null}
      updateState={updateState}
      windowState={{ isMaximized: false }}
      onSelectHome={vi.fn()}
      onSelectSftp={vi.fn()}
      onSelectContainers={vi.fn()}
      onSelectSession={vi.fn()}
      onSelectWorkspace={vi.fn()}
      onCloseSession={vi.fn().mockResolvedValue(undefined)}
      onCloseWorkspace={vi.fn().mockResolvedValue(undefined)}
      onStartSessionDrag={vi.fn()}
      onEndSessionDrag={vi.fn()}
      onDetachSessionToStandalone={vi.fn()}
      onReorderDynamicTab={vi.fn()}
      onCheckForUpdates={vi.fn().mockResolvedValue(undefined)}
      onDownloadUpdate={vi.fn().mockResolvedValue(undefined)}
      onInstallUpdate={vi.fn().mockResolvedValue(undefined)}
      onDismissUpdate={vi.fn().mockResolvedValue(undefined)}
      onOpenReleasePage={vi.fn().mockResolvedValue(undefined)}
      onMinimizeWindow={vi.fn().mockResolvedValue(undefined)}
      onMaximizeWindow={vi.fn().mockResolvedValue(undefined)}
      onRestoreWindow={vi.fn().mockResolvedValue(undefined)}
      onCloseWindow={vi.fn().mockResolvedValue(undefined)}
    />
  );
}

describe('AppTitleBar update popover', () => {
  it('closes when clicking outside the update menu', () => {
    renderTitleBar();

    fireEvent.click(screen.getByRole('button', { name: '업데이트 상태 보기' }));

    expect(screen.getByTestId('update-popover')).toBeInTheDocument();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByTestId('update-popover')).not.toBeInTheDocument();
  });

  it('renders the fixed containers tab and routes select actions', async () => {
    const onSelectContainers = vi.fn();

    render(
      <AppTitleBar
        desktopPlatform="darwin"
        tabs={[]}
        workspaces={[]}
        tabStrip={[]}
        activeWorkspaceTab="containers"
        draggedSession={null}
        updateState={createUpdateState()}
        windowState={{ isMaximized: false }}
        onSelectHome={vi.fn()}
        onSelectSftp={vi.fn()}
        onSelectContainers={onSelectContainers}
        onSelectSession={vi.fn()}
        onSelectWorkspace={vi.fn()}
        onCloseSession={vi.fn().mockResolvedValue(undefined)}
        onCloseWorkspace={vi.fn().mockResolvedValue(undefined)}
        onStartSessionDrag={vi.fn()}
        onEndSessionDrag={vi.fn()}
        onDetachSessionToStandalone={vi.fn()}
        onReorderDynamicTab={vi.fn()}
        onCheckForUpdates={vi.fn().mockResolvedValue(undefined)}
        onDownloadUpdate={vi.fn().mockResolvedValue(undefined)}
        onInstallUpdate={vi.fn().mockResolvedValue(undefined)}
        onDismissUpdate={vi.fn().mockResolvedValue(undefined)}
        onOpenReleasePage={vi.fn().mockResolvedValue(undefined)}
        onMinimizeWindow={vi.fn().mockResolvedValue(undefined)}
        onMaximizeWindow={vi.fn().mockResolvedValue(undefined)}
        onRestoreWindow={vi.fn().mockResolvedValue(undefined)}
        onCloseWindow={vi.fn().mockResolvedValue(undefined)}
      />
    );

    const selectButton = screen.getByText('Containers').closest('button');
    expect(selectButton).not.toBeNull();

    fireEvent.click(selectButton!);
    expect(onSelectContainers).toHaveBeenCalledTimes(1);
  });

  it('keeps inactive top-level tabs readable on the dark title bar', () => {
    renderTitleBar();

    const sftpButton = screen.getByRole('button', { name: 'SFTP' });
    expect(sftpButton.className).toContain('bg-[rgba(255,255,255,0.08)]');
    expect(sftpButton.className).toContain('text-[rgba(243,247,251,0.78)]');
  });

  it('renders dynamic session tabs as a single pill with the close affordance inside', () => {
    const { container } = render(
      <AppTitleBar
        desktopPlatform="darwin"
        tabs={[
          {
            id: 'tab-1',
            sessionId: 'session-1',
            source: 'host',
            hostId: 'host-1',
            title: 'mqtt/evo-parser',
            status: 'connected',
            lastEventAt: new Date().toISOString(),
          },
        ]}
        workspaces={[]}
        tabStrip={[{ kind: 'session', sessionId: 'session-1' }]}
        activeWorkspaceTab="home"
        draggedSession={null}
        updateState={createUpdateState()}
        windowState={{ isMaximized: false }}
        onSelectHome={vi.fn()}
        onSelectSftp={vi.fn()}
        onSelectContainers={vi.fn()}
        onSelectSession={vi.fn()}
        onSelectWorkspace={vi.fn()}
        onCloseSession={vi.fn().mockResolvedValue(undefined)}
        onCloseWorkspace={vi.fn().mockResolvedValue(undefined)}
        onStartSessionDrag={vi.fn()}
        onEndSessionDrag={vi.fn()}
        onDetachSessionToStandalone={vi.fn()}
        onReorderDynamicTab={vi.fn()}
        onCheckForUpdates={vi.fn().mockResolvedValue(undefined)}
        onDownloadUpdate={vi.fn().mockResolvedValue(undefined)}
        onInstallUpdate={vi.fn().mockResolvedValue(undefined)}
        onDismissUpdate={vi.fn().mockResolvedValue(undefined)}
        onOpenReleasePage={vi.fn().mockResolvedValue(undefined)}
        onMinimizeWindow={vi.fn().mockResolvedValue(undefined)}
        onMaximizeWindow={vi.fn().mockResolvedValue(undefined)}
        onRestoreWindow={vi.fn().mockResolvedValue(undefined)}
        onCloseWindow={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const sessionButton = screen.getByRole('button', { name: 'mqtt/evo-parser' });
    const closeButton = screen.getByRole('button', { name: 'mqtt/evo-parser 세션 종료' });
    const pill = sessionButton.closest('.group');

    expect(pill).toBeTruthy();
    expect(pill?.className).toContain('bg-[rgba(255,255,255,0.08)]');
    expect(pill?.contains(closeButton)).toBe(true);
    expect(container.querySelectorAll('.group').length).toBeGreaterThan(0);
  });

  it('makes the active dynamic session tab visually distinct from inactive pills', () => {
    render(
      <AppTitleBar
        desktopPlatform="darwin"
        tabs={[
          {
            id: 'tab-1',
            sessionId: 'session-1',
            source: 'host',
            hostId: 'host-1',
            title: 'mqtt/evo-parser',
            status: 'connected',
            lastEventAt: new Date().toISOString(),
          },
        ]}
        workspaces={[]}
        tabStrip={[{ kind: 'session', sessionId: 'session-1' }]}
        activeWorkspaceTab="session:session-1"
        draggedSession={null}
        updateState={createUpdateState()}
        windowState={{ isMaximized: false }}
        onSelectHome={vi.fn()}
        onSelectSftp={vi.fn()}
        onSelectContainers={vi.fn()}
        onSelectSession={vi.fn()}
        onSelectWorkspace={vi.fn()}
        onCloseSession={vi.fn().mockResolvedValue(undefined)}
        onCloseWorkspace={vi.fn().mockResolvedValue(undefined)}
        onStartSessionDrag={vi.fn()}
        onEndSessionDrag={vi.fn()}
        onDetachSessionToStandalone={vi.fn()}
        onReorderDynamicTab={vi.fn()}
        onCheckForUpdates={vi.fn().mockResolvedValue(undefined)}
        onDownloadUpdate={vi.fn().mockResolvedValue(undefined)}
        onInstallUpdate={vi.fn().mockResolvedValue(undefined)}
        onDismissUpdate={vi.fn().mockResolvedValue(undefined)}
        onOpenReleasePage={vi.fn().mockResolvedValue(undefined)}
        onMinimizeWindow={vi.fn().mockResolvedValue(undefined)}
        onMaximizeWindow={vi.fn().mockResolvedValue(undefined)}
        onRestoreWindow={vi.fn().mockResolvedValue(undefined)}
        onCloseWindow={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const sessionButton = screen.getByRole('button', { name: 'mqtt/evo-parser' });
    const pill = sessionButton.closest('.group');

    expect(pill).toBeTruthy();
    expect(pill?.className).toContain('bg-[rgba(255,255,255,0.96)]');
    expect(pill?.className).toContain('border-[rgba(255,255,255,0.24)]');
    expect(sessionButton.className).toContain('text-[var(--accent-strong)]');
  });
});
