import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { HostRecord, SecretMetadataRecord } from '@shared';
import { HostDrawer } from './HostDrawer';

const editHost: HostRecord = {
  id: 'host-1',
  kind: 'ssh',
  label: 'App Server',
  hostname: 'app.example.com',
  port: 22,
  username: 'ubuntu',
  authType: 'password',
  privateKeyPath: null,
  secretRef: null,
  groupName: 'Servers',
  tags: ['app'],
  terminalThemeId: null,
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z'
};

function renderDrawer(options?: {
  mode?: 'create' | 'edit';
  open?: boolean;
  onClose?: () => void;
  host?: HostRecord | null;
  keychainEntries?: SecretMetadataRecord[];
}) {
  const onClose = options?.onClose ?? vi.fn();
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const onConnect = vi.fn().mockResolvedValue(undefined);

  return {
    onClose,
    onSubmit,
    onConnect,
    ...render(
      <HostDrawer
        open={options?.open ?? true}
        mode={options?.mode ?? 'edit'}
        host={options?.host ?? (options?.mode === 'create' ? null : editHost)}
        keychainEntries={options?.keychainEntries ?? []}
        groupOptions={[
          { value: null, label: 'Ungrouped' },
          { value: 'Servers', label: 'Servers' }
        ]}
        onClose={onClose}
        onSubmit={onSubmit}
        onConnect={onConnect}
        onEditExistingSecret={vi.fn()}
        onOpenSecrets={vi.fn()}
      />
    )
  };
}

describe('HostDrawer close behavior', () => {
  it('does not close on outside clicks in edit mode (stays open)', () => {
    const { onClose } = renderDrawer({ mode: 'edit' });

    fireEvent.mouseDown(document.body);
    fireEvent.contextMenu(document.body);

    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not close when clicking inside the edit drawer header or form', () => {
    const { onClose } = renderDrawer({ mode: 'edit' });

    fireEvent.mouseDown(screen.getByLabelText('Label'));
    fireEvent.mouseDown(screen.getByLabelText('Hostname'));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not close from outside clicks in create mode', () => {
    const { onClose } = renderDrawer({ mode: 'create' });

    fireEvent.mouseDown(document.body);

    expect(onClose).not.toHaveBeenCalled();
  });

  it('still closes from the explicit close button', () => {
    const { onClose } = renderDrawer({ mode: 'edit' });

    fireEvent.click(screen.getByRole('button', { name: 'Close host editor' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders a fixed footer for create mode', () => {
    renderDrawer({ mode: 'create' });

    expect(screen.getByTestId('drawer-scroll-body')).toBeInTheDocument();
    expect(screen.getByTestId('drawer-footer')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Host' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('renders only the save action in the fixed footer for edit mode', () => {
    renderDrawer({ mode: 'edit' });

    expect(screen.getByRole('button', { name: '저장' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('submits create mode from the footer action', async () => {
    const { onSubmit } = renderDrawer({ mode: 'create' });

    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'New host' } });
    fireEvent.change(screen.getByLabelText('Hostname'), { target: { value: 'new.example.com' } });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Host' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'ssh',
        label: 'New host',
        hostname: 'new.example.com',
        username: '',
      }),
      expect.objectContaining({
        password: undefined,
        passphrase: undefined,
      }),
    );
  });

  it('saves from the footer action without connecting', async () => {
    const { onSubmit, onConnect } = renderDrawer({ mode: 'edit' });

    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Prod SSH' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ label: 'Prod SSH' });
    expect(onConnect).not.toHaveBeenCalled();
  });

  it('shows save status text in the footer after an explicit save', async () => {
    const { onSubmit } = renderDrawer({ mode: 'edit' });

    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Prod API' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(within(screen.getByTestId('drawer-footer')).getByText('Saved')).toBeInTheDocument(),
    );
  });
});
