// normalizeHostRecord 는 필드를 나열해 레코드를 새로 만드는 화이트리스트다. 여기서 빠진 필드는
// **파일에는 저장되는데 앱을 다시 켜면 사라진다** — 그리고 updatedAt 이 그대로라서, 벗겨진
// 레코드를 push 하면 서버의 정상 사본을 "같은 타임스탬프 · 다른 내용"으로 덮어써 다른 기기에서도
// 지워진다(detectedOs 가 실제로 그렇게 새고 있었다).
//
// 종류마다 반환문이 따로라, 새 필드를 한 분기에만 넣고 나머지를 잊는 것이 이 함수의 기본 실수다.
// 그래서 일곱 종류를 모두 돌린다.

import { describe, expect, it, vi } from 'vitest';
import os from 'node:os';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => os.tmpdir()),
    getVersion: vi.fn(() => '1.9.11-test'),
    isPackaged: false,
  },
  safeStorage: { isEncryptionAvailable: () => false },
}));

const { normalizeHostRecord } = await import('./state-storage');

const DETECTED_OS = {
  id: 'ubuntu',
  like: 'debian',
  prettyName: 'Ubuntu 24.04.3 LTS',
};

const BASE = {
  id: 'host-1',
  label: 'Probe',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-09-09T00:00:00.000Z',
};

/** 종류별로 정규화를 통과하는 최소 레코드. */
const STORED_BY_KIND: Record<string, Record<string, unknown>> = {
  ssh: { ...BASE, kind: 'ssh', hostname: 'h.example.com', port: 22, username: 'ubuntu' },
  'aws-ec2': {
    ...BASE,
    kind: 'aws-ec2',
    awsProfileName: 'default',
    awsRegion: 'ap-northeast-2',
    awsInstanceId: 'i-1',
  },
  'aws-ecs': {
    ...BASE,
    kind: 'aws-ecs',
    awsProfileName: 'default',
    awsRegion: 'ap-northeast-2',
    awsEcsClusterArn: 'arn:aws:ecs:ap-northeast-2:1:cluster/c',
    awsEcsClusterName: 'c',
  },
  'warpgate-ssh': {
    ...BASE,
    kind: 'warpgate-ssh',
    warpgateBaseUrl: 'https://wg.example.com',
    warpgateSshHost: 'wg.example.com',
    warpgateSshPort: 2222,
    warpgateTargetId: 't-1',
    warpgateTargetName: 'target',
    warpgateUsername: 'user',
  },
  serial: { ...BASE, kind: 'serial', transport: 'local', baudRate: 115200 },
  rdp: { ...BASE, kind: 'rdp', hostname: 'rdp.example.com' },
  vnc: { ...BASE, kind: 'vnc', hostname: 'vnc.example.com' },
};

describe('normalizeHostRecord 의 detectedOs 보존', () => {
  it.each(Object.keys(STORED_BY_KIND))(
    '%s 레코드의 detectedOs 가 디스크 리로드에서 살아남는다',
    (kind) => {
      const normalized = normalizeHostRecord({
        ...STORED_BY_KIND[kind],
        detectedOs: DETECTED_OS,
      });

      expect(normalized).not.toBeNull();
      expect(normalized?.kind).toBe(kind);
      expect(normalized?.detectedOs).toEqual(DETECTED_OS);
      // 타임스탬프도 그대로여야 한다 — 갱신해 버리면 서버 LWW 를 이겨 남의 수정을 덮는다.
      expect(normalized?.updatedAt).toBe(BASE.updatedAt);
    },
  );

  it('감지값이 없으면 null 이다(없음과 이상함을 같게 다룬다)', () => {
    expect(normalizeHostRecord(STORED_BY_KIND.ssh)?.detectedOs).toBeNull();
    for (const broken of [null, 42, 'ubuntu', {}, { id: '' }, { id: '  ' }, { like: 'debian' }]) {
      expect(
        normalizeHostRecord({ ...STORED_BY_KIND.ssh, detectedOs: broken })?.detectedOs,
      ).toBeNull();
    }
  });

  it('id 만 있으면 나머지는 null 로 채운다', () => {
    expect(
      normalizeHostRecord({ ...STORED_BY_KIND.ssh, detectedOs: { id: 'alpine' } })?.detectedOs,
    ).toEqual({ id: 'alpine', like: null, prettyName: null });
  });

  it('모르는 필드는 감지값에 실어 오지 않는다', () => {
    expect(
      normalizeHostRecord({
        ...STORED_BY_KIND.ssh,
        detectedOs: { ...DETECTED_OS, versionId: '24.04' },
      })?.detectedOs,
    ).toEqual(DETECTED_OS);
  });
});
