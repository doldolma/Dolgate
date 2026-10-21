import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { HostRecord } from '@shared';
import { HostDrawer } from './HostDrawer';

// 서랍은 홈이 정한 볼트를 폼까지 넘겨야 한다 — 폼이 그 볼트로 AWS 프로필을 읽고, 팀 호스트의 사람마다 다른 칸에
// 툴팁을 단다. 폼 시험은 폼에 바로 주므로 서랍이 안 넘겨도 초록이다.

const host: HostRecord = {
  id: 'host-1',
  kind: 'ssh',
  label: 'App Server',
  hostname: 'app.example.com',
  port: 22,
  username: 'ubuntu',
  authType: 'password',
  privateKeyPath: null,
  secretRef: null,
  groupName: null,
  tags: [],
  terminalThemeId: null,
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
} as HostRecord;

function renderDrawer(vaultId?: string) {
  render(
    <HostDrawer
      open
      mode="edit"
      host={host}
      keychainEntries={[]}
      serverSupportsDataFloor
      groupOptions={[{ value: null, label: 'Ungrouped' }]}
      vaultId={vaultId}
      onClose={vi.fn()}
      onSubmit={vi.fn().mockResolvedValue(undefined)}
      onEditExistingSecret={vi.fn()}
    />,
  );
}

describe('HostDrawer vault', () => {
  it("passes a team host's vault down to the form", () => {
    renderDrawer('team-1');

    fireEvent.mouseEnter(screen.getByRole('switch', { name: 'SSH 에이전트 포워딩' }).parentElement as HTMLElement);
    expect(screen.getByRole('tooltip').textContent).toBe('나에게만 적용됩니다 — 팀원의 설정은 그대로입니다.');
  });

  it('passes nothing for a personal host', () => {
    renderDrawer();

    fireEvent.mouseEnter(screen.getByRole('switch', { name: 'SSH 에이전트 포워딩' }).parentElement as HTMLElement);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
