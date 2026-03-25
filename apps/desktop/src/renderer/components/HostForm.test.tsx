import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SecretMetadataRecord, SshHostRecord } from '@shared';
import { HostForm } from './HostForm';

const groupOptions = [{ value: null, label: 'Ungrouped' }];
const keychainEntries: SecretMetadataRecord[] = [];

function createHost(overrides: Partial<SshHostRecord> = {}): SshHostRecord {
  return {
    id: 'host-1',
    kind: 'ssh',
    label: 'Prod',
    hostname: 'prod.example.com',
    port: 22,
    username: 'ubuntu',
    authType: 'password',
    privateKeyPath: null,
    secretRef: null,
    groupName: null,
    tags: [],
    terminalThemeId: null,
    createdAt: '2026-03-25T00:00:00.000Z',
    updatedAt: '2026-03-25T00:00:00.000Z',
    ...overrides
  };
}

async function wait(duration: number) {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, duration));
  });
}

describe('HostForm', () => {
  it('auto-saves edit-mode changes after the debounce window', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    render(<HostForm host={createHost()} keychainEntries={keychainEntries} groupOptions={groupOptions} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Prod API' } });

    await wait(250);
    expect(onSubmit).not.toHaveBeenCalled();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1), { timeout: 1200 });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'Prod API'
      }),
      undefined
    );
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('keeps create mode manual and still shows the Create Host button', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    render(<HostForm host={null} keychainEntries={keychainEntries} groupOptions={groupOptions} onSubmit={onSubmit} />);

    expect(screen.getByRole('button', { name: 'Create Host' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'New host' } });
    await wait(900);

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('flushes pending changes before connecting in edit mode', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onConnect = vi.fn().mockResolvedValue(undefined);

    render(
      <HostForm
        host={createHost()}
        keychainEntries={keychainEntries}
        groupOptions={groupOptions}
        onSubmit={onSubmit}
        onConnect={onConnect}
      />
    );

    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Prod SSH' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onConnect).toHaveBeenCalledWith('host-1');
    expect(onSubmit.mock.invocationCallOrder[0]).toBeLessThan(onConnect.mock.invocationCallOrder[0]);
  });

  it('disables Connect only while an auto-save request is in flight', async () => {
    let resolveSave: (() => void) | null = null;
    const onSubmit = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        })
    );

    render(<HostForm host={createHost()} keychainEntries={keychainEntries} groupOptions={groupOptions} onSubmit={onSubmit} onConnect={vi.fn()} />);

    const connectButton = screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement;
    expect(connectButton.disabled).toBe(false);

    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Prod SSH' } });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1), { timeout: 1200 });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(connectButton.disabled).toBe(true);

    await act(async () => {
      resolveSave?.();
      await Promise.resolve();
    });

    expect(connectButton.disabled).toBe(false);
  });

  it('does not overwrite local edits when the same host id rehydrates while dirty', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<HostForm host={createHost()} keychainEntries={keychainEntries} groupOptions={groupOptions} onSubmit={onSubmit} />);

    const labelInput = screen.getByLabelText('Label') as HTMLInputElement;
    fireEvent.change(labelInput, { target: { value: 'Dirty local label' } });

    rerender(
      <HostForm
        host={createHost({
          label: 'Server-side label',
          updatedAt: '2026-03-25T00:01:00.000Z'
        })}
        keychainEntries={keychainEntries}
        groupOptions={groupOptions}
        onSubmit={onSubmit}
      />
    );

    expect((screen.getByLabelText('Label') as HTMLInputElement).value).toBe('Dirty local label');
  });

  it('does not append a duplicate tag when enter is followed by blur', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    render(<HostForm host={createHost()} keychainEntries={keychainEntries} groupOptions={groupOptions} onSubmit={onSubmit} />);

    const tagInput = screen.getByPlaceholderText('Type a tag and press Enter');
    fireEvent.change(tagInput, { target: { value: '개발' } });
    fireEvent.keyDown(tagInput, { key: 'Enter' });
    fireEvent.blur(tagInput);

    expect(screen.getAllByText('개발')).toHaveLength(1);
  });
});
