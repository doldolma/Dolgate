import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appStore } from '../store/appStore';
import { createEmptyVaultIndex } from '../store/utils';
import { useTeamVaultLists } from './useTeamVaultLists';

// 설정의 볼트별 묶음(4-7) — 볼트 표의 팀마다 그 팀 목록을 읽는다. 팀이 없으면 읽지 않는다.

const teams = (...ids: string[]) => ({
  ...createEmptyVaultIndex(),
  teams: ids.map((id) => ({ id, name: id, role: 'owner' as const, syncState: 'ready' as const, syncError: null, groups: [] })),
});

beforeEach(() => {
  appStore.setState(appStore.getInitialState(), true);
});

describe('useTeamVaultLists', () => {
  it('reads nothing without teams', async () => {
    const load = vi.fn(async () => [{ id: 'x' }]);
    const { result } = renderHook(() => useTeamVaultLists(load));

    await act(async () => {});
    expect(load).not.toHaveBeenCalled();
    expect(result.current.listsByTeamId).toEqual({});
  });

  it("reads each team's list, again when the vault index or the reload key changes, an unreadable team as empty", async () => {
    appStore.setState({ vaultIndex: teams('team-a', 'team-b') });
    const load = vi.fn(async (teamId: string) => {
      if (teamId === 'team-b') {
        throw new Error('locked');
      }
      return [{ id: `${teamId}-1` }];
    });
    const { result, rerender } = renderHook(({ key }) => useTeamVaultLists(load, key), { initialProps: { key: 1 } });

    await waitFor(() => expect(result.current.listsByTeamId).toEqual({ 'team-a': [{ id: 'team-a-1' }], 'team-b': [] }));
    expect(load).toHaveBeenCalledTimes(2);

    // 쓰기 뒤 개인 목록을 다시 읽으면(reloadKey) 팀 것도 다시 읽는다.
    rerender({ key: 2 });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(4));

    // 팀이 빠지면 그 팀 목록도 빠진다.
    act(() => appStore.setState({ vaultIndex: teams('team-a') }));
    await waitFor(() => expect(result.current.listsByTeamId).toEqual({ 'team-a': [{ id: 'team-a-1' }] }));
  });
});
