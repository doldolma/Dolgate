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

    expect(document.querySelector('.update-popover')).toBeInTheDocument();

    fireEvent.mouseDown(document.body);

    expect(document.querySelector('.update-popover')).not.toBeInTheDocument();
  });
});
