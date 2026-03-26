import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { HostRecord } from '@shared';
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
}) {
  const onClose = options?.onClose ?? vi.fn();

  return {
    onClose,
    ...render(
      <HostDrawer
        open={options?.open ?? true}
        mode={options?.mode ?? 'edit'}
        host={options?.mode === 'create' ? null : editHost}
        keychainEntries={[]}
        groupOptions={[
          { value: null, label: 'Ungrouped' },
          { value: 'Servers', label: 'Servers' }
        ]}
        onClose={onClose}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        onConnect={vi.fn().mockResolvedValue(undefined)}
        onDelete={vi.fn().mockResolvedValue(undefined)}
        onEditExistingSecret={vi.fn()}
        onOpenSecrets={vi.fn()}
      />
    )
  };
}

describe('HostDrawer outside-click close', () => {
  it('closes when clicking outside in edit mode', () => {
    const { onClose } = renderDrawer({ mode: 'edit' });

    fireEvent.mouseDown(document.body);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close when clicking inside the edit drawer header or form', () => {
    const { onClose } = renderDrawer({ mode: 'edit' });

    fireEvent.mouseDown(screen.getByRole('heading', { name: 'App Server' }));
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

    fireEvent.click(screen.getByRole('button', { name: 'Close host drawer' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
