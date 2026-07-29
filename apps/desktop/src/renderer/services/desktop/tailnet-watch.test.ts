import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TailnetStatus } from '@shared';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    onTailnetStatus: vi.fn(),
    snapshotTailnets: vi.fn(),
  },
}));

vi.mock('./tailnet', () => mocks);

import { appStore } from '../../store/appStore';
import {
  acquireTailnetWatch,
  forgetTailnetStatus,
  startTailnetStatusStream,
} from './tailnet-watch';

function emit(status: TailnetStatus) {
  for (const [listener] of mocks.onTailnetStatus.mock.calls) {
    (listener as (value: TailnetStatus) => void)(status);
  }
}

describe('tailnet 상태 공유', () => {
  beforeEach(() => {
    mocks.onTailnetStatus.mockReset().mockReturnValue(() => {});
    mocks.snapshotTailnets.mockReset().mockResolvedValue({ statuses: [] });
    appStore.setState({ tailnetStatuses: {}, localTailnetNodeName: null });
  });

  // 화면마다 따로 읽으면 설정과 터미널이 서로 다른 말을 한다. 노드는 tailnet 단위로 공유되므로
  // 상태도 한곳에 모여야 한다.
  it('코어가 밀어 준 상태를 스토어에 모은다', () => {
    const stop = startTailnetStatusStream();

    emit({ id: 'net-1', state: 'needsAuth', authUrl: 'https://login', ready: false });

    expect(appStore.getState().tailnetStatuses['net-1']).toMatchObject({
      state: 'needsAuth',
      authUrl: 'https://login',
    });
    stop();
  });

  // 여러 화면이 동시에 볼 수 있다. 각자 타이머를 돌리면 같은 조회가 겹친다.
  it('보는 화면이 여러 개여도 조회는 한 번만 돈다', async () => {
    const releaseA = acquireTailnetWatch();
    const releaseB = acquireTailnetWatch();

    await Promise.resolve();
    expect(mocks.snapshotTailnets).toHaveBeenCalledTimes(1);

    releaseA();
    releaseB();
  });

  it('노드가 사라진 tailnet 의 상태는 지운다', () => {
    appStore.setState({
      tailnetStatuses: { 'net-1': { id: 'net-1', state: 'running' } as TailnetStatus },
    });

    forgetTailnetStatus('net-1');

    expect(appStore.getState().tailnetStatuses['net-1']).toBeUndefined();
  });
});
