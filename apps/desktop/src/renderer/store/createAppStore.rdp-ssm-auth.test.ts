import { describe, expect, it, vi } from 'vitest';
import type { HostRecord } from '@shared';

import { createAppStore } from './createAppStore';
import { createMockApi } from './createAppStore.test-support';

// SSM 을 경유하는 RDP 호스트는 접속 전에 AWS 인증이 살아 있어야 한다.
//
// 이 단계가 없으면 메인이 터널을 열다 SDK 원문 오류로 끝난다("The SSO session token associated with
// profile=... was not found or is invalid"). 다른 호스트 종류는 접속 전에 이 관문을 지나 브라우저
// 로그인을 띄우는데 RDP 만 건너뛰고 있었다.
//
// 프로파일을 **이름으로** 찾는 것이 이 경로의 핵심이다. RdpAwsSsmTarget 은 id 를 들고 있지 않다
// (호스트 레코드는 동기화되고 id 는 기기마다 다르다). 이름으로 상태를 얻어 그 안의 id 로 로그인한다.

const SSM_RDP_HOST: HostRecord = {
  id: 'rdp-ssm',
  kind: 'rdp',
  label: 'Win via SSM',
  hostname: '10.0.2.181',
  port: 3389,
  awsSsm: {
    profileName: 'admin',
    region: 'ap-northeast-2',
    instanceId: 'i-0abc',
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as HostRecord;

// id 를 들고 있는 레코드(임포트가 넣어 준다). 이름은 바뀔 수 있으므로 id 가 신원이다.
const SSM_RDP_HOST_WITH_ID: HostRecord = {
  ...(SSM_RDP_HOST as unknown as Record<string, unknown>),
  id: 'rdp-ssm-id',
  awsSsm: {
    profileId: 'profile-1',
    profileName: 'admin',
    region: 'ap-northeast-2',
    instanceId: 'i-0abc',
  },
} as unknown as HostRecord;

const DIRECT_RDP_HOST: HostRecord = {
  id: 'rdp-direct',
  kind: 'rdp',
  label: 'Win on LAN',
  hostname: '10.0.0.9',
  port: 3389,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as HostRecord;

function seed(hosts: HostRecord[]) {
  const api = createMockApi();
  const store = createAppStore(api);
  store.setState({ hosts });
  return { api, store };
}

describe('SSM 경유 RDP 의 AWS 인증 관문', () => {
  it('SSO 세션이 만료됐으면 접속 전에 브라우저 로그인을 띄운다', async () => {
    const { api, store } = seed([SSM_RDP_HOST]);
    api.aws.getProfileStatus = vi.fn().mockResolvedValue({
      id: 'profile-1',
      profileName: 'admin',
      available: true,
      isSsoProfile: true,
      isAuthenticated: false,
      errorMessage: null,
    });
    // 로그인 뒤 재확인은 id 로 한다.
    api.aws.getProfileStatusById = vi.fn().mockResolvedValue({
      id: 'profile-1',
      profileName: 'admin',
      available: true,
      isSsoProfile: true,
      isAuthenticated: true,
      errorMessage: null,
    });

    await store.getState().connectHost('rdp-ssm', 80, 24);

    // 레코드에 id 가 없으므로 이름으로 찾고, 로그인 자체는 그 상태가 준 id 로 한다.
    expect(api.aws.getProfileStatus).toHaveBeenCalledWith('admin');
    expect(api.aws.loginById).toHaveBeenCalledWith('profile-1');
    // 로그인이 접속보다 먼저여야 한다 — 순서가 뒤집히면 터널이 먼저 실패한다.
    // 모의 API 타입은 실제 API 를 따르므로(vi.fn 이 아니다) 호출 순서는 vi.mocked 로 읽는다.
    expect(vi.mocked(api.aws.loginById).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.rdp.connect).mock.invocationCallOrder[0],
    );
  });

  // 레코드에 id 가 있으면 이름 조회를 건너뛴다. 이름이 바뀐 뒤에도 같은 프로파일을 찾는다.
  it('id 가 있으면 id 로 확인하고 이름으로 찾지 않는다', async () => {
    const { api, store } = seed([SSM_RDP_HOST_WITH_ID]);
    api.aws.getProfileStatusById = vi.fn().mockResolvedValue({
      id: 'profile-1',
      profileName: 'renamed-later',
      available: true,
      isSsoProfile: true,
      isAuthenticated: false,
      errorMessage: null,
    });

    await store.getState().connectHost('rdp-ssm-id', 80, 24);

    expect(api.aws.getProfileStatusById).toHaveBeenCalledWith('profile-1');
    expect(api.aws.getProfileStatus).not.toHaveBeenCalled();
    expect(api.aws.loginById).toHaveBeenCalledWith('profile-1');
  });

  it('이미 인증돼 있으면 로그인을 띄우지 않는다', async () => {
    const { api, store } = seed([SSM_RDP_HOST]);
    api.aws.getProfileStatus = vi.fn().mockResolvedValue({
      id: 'profile-1',
      profileName: 'admin',
      available: true,
      isSsoProfile: true,
      isAuthenticated: true,
      errorMessage: null,
    });

    await store.getState().connectHost('rdp-ssm', 80, 24);

    expect(api.aws.loginById).not.toHaveBeenCalled();
    expect(api.rdp.connect).toHaveBeenCalledTimes(1);
  });

  // SSO 가 아닌 프로파일은 우리가 갱신할 방법이 없다. 무엇을 해야 하는지 말하고 멈춘다.
  it('정적 자격증명 프로파일이면 이유를 남기고 접속하지 않는다', async () => {
    const { api, store } = seed([SSM_RDP_HOST]);
    api.aws.getProfileStatus = vi.fn().mockResolvedValue({
      id: 'profile-1',
      profileName: 'admin',
      available: false,
      isSsoProfile: false,
      isAuthenticated: false,
      errorMessage: 'aws configure 로 자격증명을 설정해 주세요',
    });

    await store.getState().connectHost('rdp-ssm', 80, 24);

    expect(api.rdp.connect).not.toHaveBeenCalled();
    const tab = store.getState().tabs.at(-1);
    expect(tab?.status).toBe('error');
    expect(tab?.errorMessage).toContain('aws configure');
  });

  // SSM 을 안 쓰는 RDP 호스트에 AWS 왕복을 얹으면 붙는 시간이 그만큼 늘어난다.
  it('직결 RDP 호스트는 AWS 를 건드리지 않는다', async () => {
    const { api, store } = seed([DIRECT_RDP_HOST]);

    await store.getState().connectHost('rdp-direct', 80, 24);

    expect(api.aws.getProfileStatus).not.toHaveBeenCalled();
    expect(api.rdp.connect).toHaveBeenCalledTimes(1);
  });
});
