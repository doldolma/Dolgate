import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PendingHostKeyPrompt } from '../store/createAppStore';
import { KnownHostPromptDialog } from './KnownHostPromptDialog';

const pending: PendingHostKeyPrompt = {
  sessionId: 'session-1',
  probe: {
    status: 'untrusted',
    hostId: 'host-1',
    hostLabel: 'nas',
    host: 'nas.example.com',
    port: 22,
    algorithm: 'ssh-ed25519',
    publicKeyBase64: 'AAAAB3NzaC1lZDI1NTE5AAAAI',
    fingerprintSha256: 'SHA256:abcdef',
    existing: null
  },
  action: {
    kind: 'ssh',
    hostId: 'host-1',
    cols: 120,
    rows: 32
  }
};

describe('KnownHostPromptDialog', () => {
  it('opens security settings from the prompt footer', () => {
    const onOpenSecuritySettings = vi.fn();

    render(
      <KnownHostPromptDialog
        pending={pending}
        onAccept={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
        onOpenSecuritySettings={onOpenSecuritySettings}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Security settings' }));

    expect(onOpenSecuritySettings).toHaveBeenCalledTimes(1);
  });
});
