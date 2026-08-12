import { describe, expect, it, vi } from 'vitest';
import type { HostRecord } from '@shared';

import { createAppStore } from './createAppStore';
import { createMockApi } from './createAppStore.test-support';

// RDP 인증서 신뢰는 known_hosts 가 아니라 호스트 레코드에 있다. 해제하면 그 레코드가 갱신되므로
// 스토어의 호스트 목록도 같이 갈려야 한다 — 안 그러면 설정 화면이 방금 지운 신뢰를 계속 보여준다.

const TRUSTED_RDP_HOST = {
  id: 'rdp-1',
  kind: 'rdp',
  label: 'work-pc',
  hostname: '10.0.0.5',
  port: 3389,
  certificateFingerprint: 'SHA256:cert',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as unknown as HostRecord;

describe('revokeRdpCertificateTrust', () => {
  it('메인이 돌려준 레코드로 호스트를 갈아 끼운다', async () => {
    const api = createMockApi();
    api.rdp.revokeCertificateTrust = vi.fn().mockResolvedValue({
      ...(TRUSTED_RDP_HOST as unknown as Record<string, unknown>),
      certificateFingerprint: null,
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    const store = createAppStore(api);
    store.setState({ hosts: [TRUSTED_RDP_HOST] });

    await store.getState().revokeRdpCertificateTrust('rdp-1');

    expect(api.rdp.revokeCertificateTrust).toHaveBeenCalledWith('rdp-1');
    const host = store.getState().hosts.find((item) => item.id === 'rdp-1');
    expect(
      (host as unknown as { certificateFingerprint: string | null }).certificateFingerprint,
    ).toBeNull();
    // 호스트가 사라지면 안 된다 — 신뢰만 걷어내는 조작이다.
    expect(store.getState().hosts).toHaveLength(1);
  });

  it('메인이 null 을 주면 목록을 건드리지 않는다', async () => {
    const api = createMockApi();
    api.rdp.revokeCertificateTrust = vi.fn().mockResolvedValue(null);
    const store = createAppStore(api);
    store.setState({ hosts: [TRUSTED_RDP_HOST] });

    await store.getState().revokeRdpCertificateTrust('gone');

    expect(store.getState().hosts[0]).toBe(TRUSTED_RDP_HOST);
  });
});
