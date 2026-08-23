// 뱃지 하나가 일곱 화면에서 쓰이므로, "마크가 있으면 마크 / 없으면 예전 글자" 를 여기서 못 박는다.

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { HostRecord } from '@shared';
import { HostBadge } from './HostBadge';

function host(overrides: Partial<HostRecord> = {}): HostRecord {
  return {
    id: 'host-1',
    kind: 'ssh',
    label: 'Prod',
    hostname: 'prod.example.com',
    port: 22,
    username: 'ubuntu',
    authType: 'password',
    createdAt: '',
    updatedAt: '',
    ...overrides,
  } as HostRecord;
}

describe('HostBadge', () => {
  it('감지한 OS 가 있으면 그 마크를 그린다', () => {
    render(
      <HostBadge
        host={host({ detectedOs: { id: 'ubuntu', prettyName: 'Ubuntu 20.04.6 LTS' } })}
      />,
    );
    // 이름은 감지한 원문을 그대로 쓴다 — 버전까지 보여야 쓸모가 있다.
    expect(screen.getByRole('img', { name: 'Ubuntu 20.04.6 LTS' })).toBeTruthy();
  });

  it('이름이 없으면 마크의 제목으로 대신한다', () => {
    render(<HostBadge host={host({ detectedOs: { id: 'debian' } })} />);
    expect(screen.getByRole('img', { name: 'Debian' })).toBeTruthy();
  });

  it('모르는 배포판은 ID_LIKE 의 부모 마크로 그린다', () => {
    render(<HostBadge host={host({ detectedOs: { id: 'zorin', like: 'ubuntu' } })} />);
    expect(screen.getByRole('img', { name: 'Ubuntu' })).toBeTruthy();
  });

  it('감지가 없으면 예전처럼 글자 뱃지다', () => {
    // 사용자가 원한 그대로 — 없으면 지금처럼 나온다.
    const { container } = render(<HostBadge host={host()} />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(container.textContent).toBe('S');
  });

  it('BSD 도 마크로 그린다', () => {
    render(<HostBadge host={host({ detectedOs: { id: 'freebsd' } })} />);
    expect(screen.getByRole('img', { name: 'FreeBSD' })).toBeTruthy();
  });

  it('워드마크 로고는 그림 대신 짧은 글자로 그린다', () => {
    // Synology 로고는 'Synology' 라는 글자를 그린 그림이라 30px 뱃지에서 얼룩이 된다.
    const { container } = render(
      <HostBadge host={host({ detectedOs: { id: 'dsm', prettyName: 'Synology DSM 7.2.2' } })} />,
    );
    expect(screen.getByRole('img', { name: 'Synology DSM 7.2.2' })).toBeTruthy();
    expect(container.textContent).toBe('DSM');
    expect(container.querySelector('svg')).toBeNull();
  });

  it('NAS 도 자기 마크로 그린다', () => {
    render(<HostBadge host={host({ detectedOs: { id: 'truenas' } })} />);
    const badge = screen.getByRole('img', { name: 'TrueNAS' });
    expect(badge.querySelector('svg')).toBeTruthy();
  });

  it('브랜드색은 대비가 되는 테마에만 넘긴다', () => {
    // 노란 Tux(#FCC624)는 라이트에서 안 보이므로 라이트 잉크를 넘기지 않는다 — 그러면
    // 스타일시트가 글자색으로 떨어뜨린다.
    render(<HostBadge host={host({ detectedOs: { id: 'amzn' } })} />);
    const tux = screen.getByRole('img', { name: 'Linux' });
    expect(tux.style.getPropertyValue('--host-os-ink-light')).toBe('');
    expect(tux.style.getPropertyValue('--host-os-ink-dark')).toBe('#FCC624');
    expect(tux.style.getPropertyValue('--host-os-brand')).toBe('#FCC624');
  });

  it('양쪽에서 보이는 브랜드색은 두 테마 모두에 넘긴다', () => {
    render(<HostBadge host={host({ detectedOs: { id: 'ubuntu' } })} />);
    const badge = screen.getByRole('img', { name: 'Ubuntu' });
    expect(badge.style.getPropertyValue('--host-os-ink-light')).toBe('#E95420');
    expect(badge.style.getPropertyValue('--host-os-ink-dark')).toBe('#E95420');
  });

  it('마크가 없는 OS 는 글자 뱃지로 남는다', () => {
    // Windows·Solaris 처럼 패키지에 마크가 없는 것.
    const { container } = render(
      <HostBadge host={host({ detectedOs: { id: 'windows', prettyName: 'Windows Server' } })} />,
    );
    expect(screen.queryByRole('img')).toBeNull();
    expect(container.textContent).toBe('S');
  });

  it('아는 것이 없어도 글자 뱃지로 돌아간다', () => {
    const { container } = render(
      <HostBadge host={host({ detectedOs: { id: 'plan9' }, kind: 'rdp' })} />,
    );
    expect(screen.queryByRole('img')).toBeNull();
    expect(container.textContent).toBe('RDP');
  });
});
