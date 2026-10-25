import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
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

// 새 호스트 서랍 맨 위에서 만들 볼트를 고른다(Termius 처럼). 처음 값은 서랍을 연 자리의 볼트다.
describe('HostDrawer vault picker', () => {
  const choices = [
    { id: 'personal', team: null },
    { id: 'team-1', team: { id: 'team-1', name: 'Acme Infra' } },
  ];

  function renderCreate(props: Partial<ComponentProps<typeof HostDrawer>> = {}) {
    const onVaultChange = vi.fn();
    render(
      <HostDrawer
        open
        mode="create"
        host={null}
        keychainEntries={[]}
        serverSupportsDataFloor
        groupOptions={[{ value: null, label: 'Ungrouped' }]}
        vaultId="team-1"
        vaultChoices={choices}
        onVaultChange={onVaultChange}
        onClose={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        {...props}
      />,
    );
    return { onVaultChange };
  }

  it('starts on the vault it was opened in and reports another pick', () => {
    const { onVaultChange } = renderCreate();

    const picker = screen.getByRole('button', { name: 'Vault' });
    expect(picker).toHaveTextContent('Acme Infra');
    fireEvent.click(picker);
    fireEvent.click(screen.getByRole('option', { name: /Personal/ }));

    expect(onVaultChange).toHaveBeenCalledWith('personal');
  });

  it('shows the personal vault for a drawer opened there', () => {
    renderCreate({ vaultId: null });

    expect(screen.getByRole('button', { name: 'Vault' })).toHaveTextContent('Personal');
  });

  it('sits above the host type', () => {
    renderCreate();

    const picker = screen.getByRole('button', { name: 'Vault' });
    expect(picker.compareDocumentPosition(screen.getByLabelText('Host type')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('is not there with a single vault', () => {
    renderCreate({ vaultId: null, vaultChoices: [choices[0]] });

    expect(screen.queryByRole('button', { name: 'Vault' })).toBeNull();
  });

  // 이미 있는 호스트를 다른 볼트로 옮기는 것은 공유(복사)의 일이다 — 편집 화면에는 두지 않는다.
  it('is not there while editing', () => {
    renderCreate({ mode: 'edit', host, vaultId: null, onEditExistingSecret: vi.fn() });

    expect(screen.queryByRole('button', { name: 'Vault' })).toBeNull();
  });
});
