import { describe, expect, it } from 'vitest';
import type { TerminalTab } from '@shared';
import { getSessionCapabilities } from './session-capabilities';

const tab = (fields: Partial<TerminalTab>) => ({ source: 'host', ...fields }) as TerminalTab;

describe('active session capabilities', () => {
  it.each(['ssh', 'ssh-over-ssm', 'ssh-over-ssm-proxy', 'tmux'])('supports binary transfer for %s', (kind) => {
    const session = kind === 'tmux'
      ? tab({ tmux: { controlSessionId: 'ctl', paneId: '%1', windowId: '@0' } })
      : kind === 'ssh' ? tab({ sessionProtocol: 'ssh' })
        : tab({ awsTransport: 'ssh-over-ssm' });
    expect(getSessionCapabilities(session)).toEqual({ zmodem: true, shellIntegration: true, shareTransport: 'ssh' });
  });

  it.each(['direct', 'server-proxy'])('preserves sharing for %s SSM fallback, without SSH features', () => {
    expect(getSessionCapabilities(tab({ sessionProtocol: 'ssm-shell', awsTransport: 'ssm-shell' })))
      .toEqual({ zmodem: false, shellIntegration: false, shareTransport: 'aws-ssm' });
  });

  it('does not assume an unknown or pending host connection is SSH', () => {
    expect(getSessionCapabilities(tab({ status: 'connecting' })).zmodem).toBe(false);
    expect(getSessionCapabilities(undefined).shellIntegration).toBe(false);
  });

  it.each(['serial', 'mosh'] as const)('does not enable byte-stream transfer on %s', (sessionProtocol) => {
    expect(getSessionCapabilities(tab({ sessionProtocol })).zmodem).toBe(false);
  });

  it('retains local terminal support and excludes ECS Exec', () => {
    expect(getSessionCapabilities(tab({ source: 'local' })).zmodem).toBe(true);
    expect(getSessionCapabilities(tab({ source: 'local', shellKind: 'aws-ecs-exec' })).zmodem).toBe(false);
  });
});
