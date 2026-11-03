import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VaultResetTeamsNote } from './VaultResetTeamsNote';

// 동기화 암호를 초기화하면 서버가 그 사람을 모든 팀에서 빼고 혼자인 팀은 지운다 — 확인 창이 그것을 알린다(2026-11-02 리뷰).

const mocks = vi.hoisted(() => ({ listTeams: vi.fn() }));

vi.mock('../services/desktop/auth-window-updater', () => ({
  listTeamsLeftOnVaultReset: mocks.listTeams,
}));

beforeEach(() => {
  mocks.listTeams.mockReset();
});

describe('VaultResetTeamsNote', () => {
  it('says nothing without teams', async () => {
    mocks.listTeams.mockResolvedValue([]);
    const { container } = render(<VaultResetTeamsNote />);
    await waitFor(() => expect(mocks.listTeams).toHaveBeenCalledTimes(1));
    expect(container).toBeEmptyDOMElement();
  });

  it('names the teams it leaves and the ones the server deletes', async () => {
    mocks.listTeams.mockResolvedValue([
      { name: 'Acme', soleMember: false },
      { name: 'Ops', soleMember: true },
    ]);
    render(<VaultResetTeamsNote />);
    expect(
      await screen.findByText(
        '팀 2개(Acme, Ops)에서도 빠집니다. 이 기기의 팀 데이터는 지워지고, 다시 들어오려면 새 초대 링크가 필요합니다. 혼자 있는 팀은 서버에서도 지워집니다: Ops.',
      ),
    ).toBeInTheDocument();
  });

  it('only says it leaves when every team has other members', async () => {
    mocks.listTeams.mockResolvedValue([{ name: 'Acme', soleMember: false }]);
    render(<VaultResetTeamsNote />);
    expect(
      await screen.findByText(
        '팀 1개(Acme)에서도 빠집니다. 이 기기의 팀 데이터는 지워지고, 다시 들어오려면 새 초대 링크가 필요합니다.',
      ),
    ).toBeInTheDocument();
  });

  it('warns about teams I may be alone in when the server could not tell', async () => {
    mocks.listTeams.mockResolvedValue([{ name: 'Acme', soleMember: null }]);
    render(<VaultResetTeamsNote />);
    expect(await screen.findByText(/혼자 있는 팀은 서버에서도 지워집니다\.$/)).toBeInTheDocument();
  });

  it('stays quiet when the list cannot be read', async () => {
    mocks.listTeams.mockRejectedValue(new Error('offline'));
    const { container } = render(<VaultResetTeamsNote />);
    await waitFor(() => expect(mocks.listTeams).toHaveBeenCalledTimes(1));
    expect(container).toBeEmptyDOMElement();
  });

  // 탈퇴도 서버가 모든 팀에서 빼고 혼자인 팀을 지운다. 계정이 없어지니 다시 들어오기는 말하지 않는다.
  it('leaves out rejoining when the account is deleted', async () => {
    mocks.listTeams.mockResolvedValue([
      { name: 'Acme', soleMember: false },
      { name: 'Ops', soleMember: true },
    ]);
    render(<VaultResetTeamsNote kind="accountDelete" />);
    expect(
      await screen.findByText('팀 2개(Acme, Ops)에서도 빠집니다. 혼자 있는 팀은 서버에서도 지워집니다: Ops.'),
    ).toBeInTheDocument();
  });
});
