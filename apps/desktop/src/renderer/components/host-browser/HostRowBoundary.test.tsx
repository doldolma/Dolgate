import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostRecord } from '@shared';
import { HostListCard } from './HostListCard';
import { HostRowBoundary } from './HostRowBoundary';

// 옛 빌드가 동기화로 받은 RDP 호스트를 그리다 던져서 창이 통째로 빈 화면이 됐다. 호스트 목록은
// 버전 사이에서 동기화되므로 "이 빌드가 모르는 모양" 은 앞으로도 온다 — 그때 깨지는 범위가 그 줄
// 하나로 묶이는지 잠근다.

function makeHost(overrides: Partial<HostRecord> = {}): HostRecord {
  return {
    id: 'h-ok',
    kind: 'ssh',
    label: '정상 호스트',
    hostname: 'ok.example.com',
    port: 22,
    username: 'ubuntu',
    authType: 'agent',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as HostRecord;
}

/** 읽는 순간 던지는 레코드. 이 빌드가 모르는 필드 모양을 렌더가 건드리는 상황을 대신한다. */
function makeBrokenHost(): HostRecord {
  const host = makeHost({ id: 'h-broken', label: '깨진 호스트' });
  Object.defineProperty(host, 'hostname', {
    get() {
      throw new TypeError("Cannot read properties of undefined (reading 'trim')");
    },
  });
  return host;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('HostRowBoundary', () => {
  it('한 줄이 던져도 나머지 호스트는 그대로 남는다', () => {
    const hosts = [makeHost({ id: 'h-1', label: '첫 호스트' }), makeBrokenHost(), makeHost({ id: 'h-2', label: '끝 호스트' })];

    render(
      <div>
        {hosts.map((host) => (
          <HostRowBoundary
            key={host.id}
            host={host}
            render={() => <HostListCard host={host} />}
          />
        ))}
      </div>,
    );

    expect(screen.getByText('첫 호스트')).toBeTruthy();
    expect(screen.getByText('끝 호스트')).toBeTruthy();
    expect(screen.getByText(/깨진 호스트/)).toBeTruthy();
    expect(screen.getByText(/표시할 수 없습니다/)).toBeTruthy();
  });

  it('줄 내용을 만드는 중에 던져도 잡는다', () => {
    // 부모 렌더에서 값을 계산하면 바운더리를 지나쳐 목록 전체가 죽는다. render 함수로 받는 이유다.
    render(
      <div>
        <span>목록 머리글</span>
        <HostRowBoundary
          host={makeHost({ id: 'h-3', label: '계산 실패' })}
          render={() => {
            throw new TypeError('부제를 만들 수 없음');
          }}
        />
      </div>,
    );

    expect(screen.getByText('목록 머리글')).toBeTruthy();
    expect(screen.getByText(/계산 실패/)).toBeTruthy();
  });

  it('라벨도 읽을 수 없으면 id 로 적는다', () => {
    // 폴백이 던지면 그 오류는 다시 위로 올라가 목록을 죽인다.
    const host = makeHost({ id: 'h-4' });
    Object.defineProperty(host, 'label', {
      get() {
        throw new TypeError('label 읽기 실패');
      },
    });

    render(
      <HostRowBoundary
        host={host}
        render={() => {
          throw new TypeError('행 렌더 실패');
        }}
      />,
    );

    expect(screen.getByText(/h-4/)).toBeTruthy();
  });
});
