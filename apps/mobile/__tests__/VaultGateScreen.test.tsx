import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Alert } from 'react-native';
import { describeTeamsLeftOnVaultReset } from '../src/lib/vault-reset-teams';
import { VaultUnlockScreen } from '../src/screens/VaultGateScreen';
import { useMobileAppStore } from '../src/store/useMobileAppStore';

// 동기화 암호를 초기화하면 서버가 그 사람을 모든 팀에서 빼고 혼자인 팀은 지운다 — 첫 확인 창이 그것을 알린다(2026-11-02 리뷰).

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => null),
  removeItem: jest.fn(async () => null),
  clear: jest.fn(async () => null),
}));
jest.mock('react-native-keychain', () => ({
  ACCESSIBLE: {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  },
  getGenericPassword: jest.fn(async () => null),
  setGenericPassword: jest.fn(async () => true),
  resetGenericPassword: jest.fn(async () => true),
}));
jest.mock('../src/lib/screen-layout', () => ({
  useScreenPadding: () => ({
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
  }),
}));

const RESET_BODY =
  '동기화 암호 없이는 서버에 저장된 데이터를 복구할 수 없습니다. 초기화하면 서버의 호스트·자격 증명이 모두 삭제되고 새로 시작합니다.';

describe('describeTeamsLeftOnVaultReset', () => {
  it('says nothing without teams', () => {
    expect(describeTeamsLeftOnVaultReset([])).toBeNull();
  });

  it('names the teams it leaves and the ones the server deletes', () => {
    expect(
      describeTeamsLeftOnVaultReset([
        { name: 'Acme', soleMember: false },
        { name: 'Ops', soleMember: true },
      ]),
    ).toBe(
      '팀(Acme, Ops)에서도 빠집니다. 이 폰의 팀 데이터는 지워지고, 다시 들어오려면 데스크톱에서 새 초대 링크로 들어와야 합니다. 혼자 있는 팀은 서버에서도 지워집니다: Ops.',
    );
  });

  it('only says it leaves when every team has other members, and warns in general when unknown', () => {
    expect(
      describeTeamsLeftOnVaultReset([{ name: 'Acme', soleMember: false }]),
    ).toBe(
      '팀(Acme)에서도 빠집니다. 이 폰의 팀 데이터는 지워지고, 다시 들어오려면 데스크톱에서 새 초대 링크로 들어와야 합니다.',
    );
    expect(
      describeTeamsLeftOnVaultReset([{ name: 'Acme', soleMember: null }]),
    ).toMatch(/혼자 있는 팀은 서버에서도 지워집니다\.$/);
  });

  // 탈퇴도 서버가 모든 팀에서 빼고 혼자인 팀을 지운다. 계정이 없어지니 다시 들어오기는 말하지 않는다.
  it('leaves out rejoining when the account is deleted', () => {
    expect(
      describeTeamsLeftOnVaultReset(
        [
          { name: 'Acme', soleMember: false },
          { name: 'Ops', soleMember: true },
        ],
        'accountDelete',
      ),
    ).toBe('팀(Acme, Ops)에서도 빠집니다. 혼자 있는 팀은 서버에서도 지워집니다: Ops.');
  });
});

describe('VaultUnlockScreen reset', () => {
  const originalList = useMobileAppStore.getState().listTeamsLeftOnVaultReset;
  const mounted: renderer.ReactTestRenderer[] = [];

  afterEach(async () => {
    // 그린 화면을 내린다 — 남겨 두면 시험이 끝난 뒤 다시 그려지며 경고를 남긴다.
    await act(async () => {
      for (const tree of mounted.splice(0)) {
        tree.unmount();
      }
    });
    useMobileAppStore.setState({ listTeamsLeftOnVaultReset: originalList });
    jest.restoreAllMocks();
  });

  function collectText(node: renderer.ReactTestInstance): string {
    return node.children
      .map(child => (typeof child === 'string' ? child : collectText(child)))
      .join('');
  }

  async function pressForgot(list: jest.Mock) {
    useMobileAppStore.setState({ listTeamsLeftOnVaultReset: list });
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    let tree: renderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderer.create(<VaultUnlockScreen />);
    });
    mounted.push(tree!);
    const forgot = tree!.root.findAll(
      node =>
        typeof node.props.onPress === 'function' &&
        collectText(node).includes('동기화 암호를 잊으셨나요'),
    )[0];
    await act(async () => {
      forgot!.props.onPress();
    });
    return alertSpy;
  }

  it('adds the teams to the first confirmation', async () => {
    const list = jest.fn(async () => [
      { name: 'Acme', soleMember: false },
      { name: 'Solo', soleMember: true },
    ]);
    const alertSpy = await pressForgot(list);

    expect(list).toHaveBeenCalledTimes(1);
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy.mock.calls[0]![1]).toBe(
      `${RESET_BODY}\n\n팀(Acme, Solo)에서도 빠집니다. 이 폰의 팀 데이터는 지워지고, 다시 들어오려면 데스크톱에서 새 초대 링크로 들어와야 합니다. 혼자 있는 팀은 서버에서도 지워집니다: Solo.`,
    );
  });

  it('keeps the plain confirmation without teams or when the list fails', async () => {
    const alertSpy = await pressForgot(jest.fn(async () => []));
    expect(alertSpy.mock.calls[0]![1]).toBe(RESET_BODY);

    jest.restoreAllMocks();
    const failingSpy = await pressForgot(jest.fn(async () => Promise.reject(new Error('offline'))));
    expect(failingSpy.mock.calls[0]![1]).toBe(RESET_BODY);
  });
});
