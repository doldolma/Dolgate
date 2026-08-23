import { describe, expect, it } from 'vitest';
import type { HostRecord } from '@shared';
import {
  buildQuickSshHostLabel,
  findExistingQuickSshHost,
  parseQuickSshCommand,
} from '@shared';

const sshHost = (overrides: Partial<Extract<HostRecord, { kind: 'ssh' }>> = {}) =>
  ({
    id: overrides.id ?? 'host-1',
    kind: 'ssh',
    label: overrides.label ?? 'ubuntu@example.com',
    hostname: overrides.hostname ?? 'example.com',
    port: overrides.port ?? 22,
    username: overrides.username ?? 'ubuntu',
    authType: overrides.authType ?? 'password',
    privateKeyPath: null,
    certificatePath: null,
    secretRef: null,
    groupName: overrides.groupName ?? 'Servers',
    tags: [],
    terminalThemeId: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  }) satisfies HostRecord;

describe('quick-connect', () => {
  it('parses basic ssh user host commands', () => {
    expect(parseQuickSshCommand('ssh acme@192.168.0.13')).toEqual({
      username: 'acme',
      hostname: '192.168.0.13',
      port: 22,
    });
  });

  it('parses colon and -p port forms', () => {
    expect(parseQuickSshCommand('ssh acme@192.168.0.13:2222')).toEqual({
      username: 'acme',
      hostname: '192.168.0.13',
      port: 2222,
    });
    expect(parseQuickSshCommand('ssh -p 2200 acme@lime.local')).toEqual({
      username: 'acme',
      hostname: 'lime.local',
      port: 2200,
    });
  });

  it('rejects unsupported ssh command shapes', () => {
    expect(parseQuickSshCommand('scp acme@192.168.0.13')).toBeNull();
    expect(parseQuickSshCommand('ssh -i key.pem acme@192.168.0.13')).toBeNull();
    expect(parseQuickSshCommand('ssh acme@192.168.0.13 whoami')).toBeNull();
    expect(parseQuickSshCommand('ssh acme@192.168.0.13:99999')).toBeNull();
  });

  it('builds duplicate labels in the selected group only', () => {
    const input = parseQuickSshCommand('ssh ubuntu@example.com')!;
    expect(
      buildQuickSshHostLabel(
        input,
        [
          sshHost({ label: 'ubuntu@example.com', groupName: 'Servers' }),
          sshHost({ id: 'host-2', label: 'ubuntu@example.com Copy', groupName: 'Servers' }),
          sshHost({ id: 'host-3', label: 'ubuntu@example.com', groupName: 'Other' }),
        ],
        'Servers',
      ),
    ).toBe('ubuntu@example.com Copy 2');
  });

  it('finds an existing ssh host without matching label or group', () => {
    const input = parseQuickSshCommand('ssh ubuntu@EXAMPLE.com')!;
    expect(
      findExistingQuickSshHost(input, [
        sshHost({ id: 'host-1', label: 'Different', hostname: 'example.com', groupName: 'Other' }),
      ])?.id,
    ).toBe('host-1');
  });
});
