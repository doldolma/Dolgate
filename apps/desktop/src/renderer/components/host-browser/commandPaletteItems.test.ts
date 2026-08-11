import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostRecord } from '@shared';
import { buildHostBrowserCommandPaletteItems } from './commandPaletteItems';
import type { HostBrowserModel } from './useHostBrowser';

// 이 빌더는 렌더 중 불리는 순수 함수라 에러 바운더리로 감싸도 팔레트가 통째로 사라진다. 모르는
// 모양의 레코드 하나 때문에 명령 팔레트 전체를 못 쓰는 일이 없어야 한다 — 옛 빌드가 동기화로 받은
// RDP 호스트에서 실제로 그 자리(부제 만들기)에서 던졌다.

function makeHost(id: string, label: string): HostRecord {
  return {
    id,
    kind: 'ssh',
    label,
    hostname: `${id}.example.com`,
    port: 22,
    username: 'ubuntu',
    authType: 'agent',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as HostRecord;
}

/** 부제·검색어를 만들 때 읽는 필드가 던지는 레코드. */
function makeBrokenHost(id: string, label: string): HostRecord {
  const host = makeHost(id, label);
  Object.defineProperty(host, 'hostname', {
    get() {
      throw new TypeError("Cannot read properties of undefined (reading 'trim')");
    },
  });
  return host;
}

function makeModel(hosts: HostRecord[], searchQuery = ''): HostBrowserModel {
  return {
    hosts,
    searchQuery,
    favoriteHostIdSet: new Set<string>(),
    lastConnectedByHostId: new Map<string, number>(),
    onConnectHost: vi.fn(),
    onOpenHostContainers: vi.fn(),
    onCreateHost: vi.fn(),
    onEditHost: vi.fn(),
  } as unknown as HostBrowserModel;
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildHostBrowserCommandPaletteItems', () => {
  it('항목을 만들다 던지는 호스트만 건너뛴다', () => {
    const items = buildHostBrowserCommandPaletteItems(
      makeModel([makeHost('h-1', '첫 호스트'), makeBrokenHost('h-2', '깨진 호스트'), makeHost('h-3', '끝 호스트')]),
    );
    const ids = items.map((item) => item.id);

    expect(ids).toContain('host:connect:h-1');
    expect(ids).toContain('host:connect:h-3');
    expect(ids).not.toContain('host:connect:h-2');
  });

  it('검색으로 걸러낼 때 던지는 호스트도 팔레트를 죽이지 않는다', () => {
    // 필터는 forEach 보다 먼저 돈다 — 여기서 새면 항목을 만들기도 전에 팔레트가 사라진다.
    const items = buildHostBrowserCommandPaletteItems(
      makeModel([makeBrokenHost('h-2', '깨진 호스트'), makeHost('h-3', 'searchme')], 'searchme'),
    );

    expect(items.map((item) => item.id)).toContain('host:connect:h-3');
  });
});
