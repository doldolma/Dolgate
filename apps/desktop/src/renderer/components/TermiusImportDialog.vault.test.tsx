import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopApi, TermiusImportHostPreview, TermiusProbeResult } from '@shared';
import { TermiusImportDialog } from './TermiusImportDialog';

const TEAM = 'team-1';
const choices = [
  { id: 'personal', team: null },
  { id: TEAM, team: { id: TEAM, name: 'Acme Infra' } }
];

function previewHost(key: string, secretKey: string | null): TermiusImportHostPreview {
  return {
    key,
    name: key,
    address: `${key}.internal`,
    groupPath: 'team',
    port: 22,
    username: 'deploy',
    hasPassword: false,
    hasPrivateKey: secretKey !== null,
    identityName: secretKey ? 'deploy-key' : null,
    secretKey
  };
}

// web-1·web-2 는 같은 Termius ID 의 키를 쓰고, misc 는 가져올 비밀값이 없다.
const probe: TermiusProbeResult = {
  status: 'ready',
  snapshotId: 'termius-1',
  message: null,
  meta: null,
  groups: [{ path: 'team', name: 'team', parentPath: null, hostCount: 3 }],
  hosts: [previewHost('web-1', 'identity:deploy'), previewHost('web-2', 'identity:deploy'), previewHost('misc', null)]
};

function installMockApi() {
  const api = {
    termius: {
      probeLocal: vi.fn().mockResolvedValue(probe),
      importSelection: vi.fn().mockResolvedValue({
        createdGroupCount: 1,
        createdHostCount: 3,
        createdSecretCount: 1,
        skippedHostCount: 0,
        warnings: []
      }),
      discardSnapshot: vi.fn().mockResolvedValue(undefined)
    }
  };
  Object.defineProperty(window, 'dolssh', { configurable: true, value: api as unknown as DesktopApi });
  return api;
}

describe('Termius import dialog — 어느 볼트로', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('imports into the vault it was opened from, sharing the identity with the team unless turned off', async () => {
    const api = installMockApi();
    const onClose = vi.fn();
    render(
      <TermiusImportDialog open vaultChoices={choices} defaultVaultId={TEAM} onClose={onClose} onImported={vi.fn()} />
    );

    expect(screen.getByRole('button', { name: 'Vault' })).toHaveTextContent('Acme Infra');
    fireEvent.click(await screen.findByRole('button', { name: 'Select all visible' }));
    const share = screen.getByRole('switch');
    expect(share).toHaveAccessibleName('비밀번호·SSH 키 1개도 함께 공유');
    expect(share).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(share);
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.termius.importSelection).toHaveBeenCalledWith({
      snapshotId: 'termius-1',
      selectedGroupPaths: ['team'],
      selectedHostKeys: ['web-1', 'web-2', 'misc'],
      vaultId: TEAM,
      shareSecrets: false
    });
  });

  it('sends nothing about vaults when you pick your own', async () => {
    const api = installMockApi();
    const onClose = vi.fn();
    render(
      <TermiusImportDialog open vaultChoices={choices} defaultVaultId={TEAM} onClose={onClose} onImported={vi.fn()} />
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Select all visible' }));

    fireEvent.click(screen.getByRole('button', { name: 'Vault' }));
    fireEvent.click(within(screen.getByRole('listbox', { name: /Vault/ })).getByRole('option', { name: 'Personal' }));
    expect(screen.queryByRole('switch')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.termius.importSelection).toHaveBeenCalledWith({
      snapshotId: 'termius-1',
      selectedGroupPaths: ['team'],
      selectedHostKeys: ['web-1', 'web-2', 'misc']
    });
  });
});
