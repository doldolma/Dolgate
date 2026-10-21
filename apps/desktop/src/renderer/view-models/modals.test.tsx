import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../store/appStore', async () => (await import('../store/appStore.test-support')).createAppStoreModuleMock());

import { appStore } from '../store/appStore';
import { createEmptyVaultIndex } from '../store/utils';
import { useAppModalViewModel } from './modals';

// 이름 묻는 창은 팀 호스트면 "내 자격 증명에 저장" 이라고 말한다 — 그 여부는 뷰모델이 볼트 표에서 실어 준다.
describe('useAppModalViewModel', () => {
  beforeEach(() => {
    appStore.setState(appStore.getInitialState(), true);
  });

  it('says whether the username prompt is for a team host', () => {
    appStore.setState({
      pendingMissingUsernamePrompt: { hostId: 'team-web', source: 'ssh' },
      vaultIndex: { ...createEmptyVaultIndex(), teamIdByHostId: { 'team-web': 'team-1' } },
    });
    const { result } = renderHook(() => useAppModalViewModel());
    expect(result.current.pendingMissingUsernameTeamHost).toBe(true);

    act(() => appStore.setState({ pendingMissingUsernamePrompt: { hostId: 'my-web', source: 'sftp' } }));
    expect(result.current.pendingMissingUsernameTeamHost).toBe(false);
  });
});
