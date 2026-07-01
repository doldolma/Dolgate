import { describe, expect, it } from 'vitest';
import type { HostRecord } from '@shared';
import { resolveHopHostNames } from './connection-hops';

function sshHost(
  over: Partial<HostRecord> & { id: string; label: string },
): HostRecord {
  return {
    kind: 'ssh',
    hostname: `${over.id}.example`,
    port: 22,
    username: 'u',
    authType: 'password',
    privateKeyPath: null,
    secretRef: null,
    jumpHostId: null,
    jumpHostIds: null,
    startupCommand: null,
    groupName: null,
    tags: [],
    terminalThemeId: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...over,
  } as HostRecord;
}

describe('resolveHopHostNames', () => {
  it('orders jump-host names first then the target (deepest jump = hop 1)', () => {
    const j0 = sshHost({ id: 'j0', label: 'Lime-GW' });
    const j1 = sshHost({ id: 'j1', label: 'Lime-DB' });
    const target = sshHost({
      id: 't',
      label: 'lime-dev',
      jumpHostIds: ['j0', 'j1'],
    });
    // hop 1 = j0(첫 홉) … hop 3 = target. connectionHopProgress가 index-1로 매핑한다.
    expect(resolveHopHostNames(target, [j0, j1, target])).toEqual([
      'Lime-GW',
      'Lime-DB',
      'lime-dev',
    ]);
  });

  it('falls back to the jump id when the jump host record is missing', () => {
    const target = sshHost({ id: 't', label: 'lime-dev', jumpHostIds: ['gone'] });
    expect(resolveHopHostNames(target, [target])).toEqual(['gone', 'lime-dev']);
  });

  it('uses the legacy single jumpHostId when jumpHostIds is empty', () => {
    const j = sshHost({ id: 'j', label: 'Bastion' });
    const target = sshHost({ id: 't', label: 'lime-dev', jumpHostId: 'j' });
    expect(resolveHopHostNames(target, [j, target])).toEqual([
      'Bastion',
      'lime-dev',
    ]);
  });

  it('returns just the target label for a direct (no-jump) host', () => {
    const target = sshHost({ id: 't', label: 'lime-dev' });
    expect(resolveHopHostNames(target, [target])).toEqual(['lime-dev']);
  });

  it('returns an empty array when there is no host', () => {
    expect(resolveHopHostNames(undefined, [])).toEqual([]);
  });
});
