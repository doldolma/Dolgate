import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopApi, WarpgateConnectionInfo, WarpgateTargetSummary } from '@shared';
import { WarpgateImportDialog } from './WarpgateImportDialog';

const connectionInfoWithoutUsername: WarpgateConnectionInfo = {
  baseUrl: 'https://warpgate.example.com',
  sshHost: 'ssh.warpgate.example.com',
  sshPort: 2222,
  username: null
};

const sshTargets: WarpgateTargetSummary[] = [
  {
    id: 'target-1',
    name: 'prod-db',
    kind: 'ssh'
  }
];

function installMockApi(connectionInfo: WarpgateConnectionInfo = connectionInfoWithoutUsername) {
  const api = {
    warpgate: {
      testConnection: vi.fn().mockResolvedValue(connectionInfo),
      listSshTargets: vi.fn().mockResolvedValue(sshTargets)
    }
  };

  Object.defineProperty(window, 'dolssh', {
    configurable: true,
    value: api as unknown as DesktopApi
  });

  return api;
}

async function loadTargets() {
  fireEvent.change(screen.getByPlaceholderText('https://warpgate.example.com'), {
    target: { value: 'https://warpgate.example.com' }
  });
  fireEvent.change(screen.getByPlaceholderText('Paste your Warpgate API token'), {
    target: { value: 'token-value' }
  });
  fireEvent.click(screen.getByRole('button', { name: 'Load SSH Targets' }));

  await waitFor(() => expect(screen.getByText('prod-db')).toBeInTheDocument());
}

describe('Warpgate import dialog', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a validation error when add host is clicked without a username', async () => {
    installMockApi();
    const onImport = vi.fn().mockResolvedValue(undefined);

    render(
      <WarpgateImportDialog
        open
        currentGroupPath={null}
        onClose={vi.fn()}
        onImport={onImport}
      />
    );

    await loadTargets();

    const addHostButton = screen.getByRole('button', { name: 'Add host' });
    expect(addHostButton).toBeEnabled();

    fireEvent.click(addHostButton);

    expect(await screen.findByText('Warpgate 사용자명을 입력해 주세요.')).toBeInTheDocument();
    expect(onImport).not.toHaveBeenCalled();
  });

  it('imports the selected target after a fallback username is entered', async () => {
    installMockApi();
    const onImport = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();

    render(
      <WarpgateImportDialog
        open
        currentGroupPath="Servers/Prod"
        onClose={onClose}
        onImport={onImport}
      />
    );

    await loadTargets();

    fireEvent.click(screen.getByRole('button', { name: 'Add host' }));
    expect(await screen.findByText('Warpgate 사용자명을 입력해 주세요.')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('example.user'), {
      target: { value: 'example.user' }
    });

    await waitFor(() =>
      expect(screen.queryByText('Warpgate 사용자명을 입력해 주세요.')).not.toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add host' }));

    await waitFor(() =>
      expect(onImport).toHaveBeenCalledWith({
        kind: 'warpgate-ssh',
        label: 'prod-db',
        groupName: 'Servers/Prod',
        tags: [],
        terminalThemeId: null,
        warpgateBaseUrl: 'https://warpgate.example.com',
        warpgateSshHost: 'ssh.warpgate.example.com',
        warpgateSshPort: 2222,
        warpgateTargetId: 'target-1',
        warpgateTargetName: 'prod-db',
        warpgateUsername: 'example.user'
      })
    );
    expect(onClose).toHaveBeenCalled();
  });
});
