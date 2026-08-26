import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { HostRecord, RdpHostRecord, SecretMetadataRecord, SshHostRecord } from '@shared';
import { HostDetailPanel } from './HostDetailPanel';
import { appStore } from '../../store/appStore';
import type { HostBrowserModel } from './useHostBrowser';

// RDP 호스트의 Connection 탭이 "Type: SSH" 한 줄만 보여주던 버그를 잠근다. 여기 없는 설정은
// 사용자가 편집 화면을 열어야 확인할 수 있고, 특히 공유 폴더는 원격에 파일이 노출되는 설정이라
// 무엇을 열어 뒀는지 이 화면에서 보여야 한다.

vi.mock('../../services/desktop/tailnet', () => ({
  listTailnets: vi.fn(async () => [{ id: 'tn-corp', label: 'corp-tailnet' }]),
}));

const keychainEntries: SecretMetadataRecord[] = [
  {
    secretRef: 'secret-rdp',
    label: '사내 관리자',
    kind: 'rdp',
    username: 'Administrator',
    domain: 'CORP',
    hasPassword: true,
    hasPassphrase: false,
    hasManagedPrivateKey: false,
    hasCertificate: false,
    linkedHostCount: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

function makeHost(overrides: Partial<RdpHostRecord> = {}): RdpHostRecord {
  return {
    id: 'h-rdp',
    kind: 'rdp',
    label: 'winbox',
    hostname: '10.0.2.181',
    port: 3389,
    secretRef: 'secret-rdp',
    tailnetId: 'tn-corp',
    adminSession: true,
    audioEnabled: false,
    clipboardEnabled: null,
    colorDepth: 16,
    useAllMonitors: true,
    drives: [{ path: '/Users/me/docs', readOnly: true }],
    certificateFingerprint: 'AA:BB:CC:DD:EE:FF',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeSshHost(): SshHostRecord {
  return {
    id: 'h-ssh',
    kind: 'ssh',
    label: 'linuxbox',
    hostname: '10.0.2.9',
    port: 22,
    username: 'ubuntu',
    authType: 'agent',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

// SFTP·tmux 핸들러는 항상 넘긴다 — 버튼이 사라진다면 핸들러가 없어서가 아니라 호스트 종류 때문이다.
function renderPanel(
  host: HostRecord,
  detailTab: 'overview' | 'connection' = 'connection',
  hosts: HostRecord[] = [host],
) {
  const hb = {
    hosts,
    selectedHostId: host.id,
    favoriteHostIdSet: new Set<string>(),
    keychainEntries,
    detailTab,
    onEditHost: vi.fn(),
    onConnectHost: vi.fn(),
    onOpenHostContainers: vi.fn(),
    onOpenSftp: vi.fn(),
    onConnectHostTmux: vi.fn(),
    toggleFavorite: vi.fn(),
    clearSelections: vi.fn(),
    selectSingleHost: vi.fn(),
  } as unknown as HostBrowserModel;
  return render(<HostDetailPanel hb={hb} />);
}

/** InfoRow 는 라벨과 값을 형제 span 으로 둔다 — 라벨로 줄을 찾아 값만 떼어낸다. */
function rowValue(label: string): string {
  const labelNode = screen.getByText(label);
  const text = labelNode.parentElement?.textContent ?? '';
  return text.slice(label.length).trim();
}

describe('HostDetailPanel — RDP Connection 탭', () => {
  it('설정한 RDP 값들을 줄로 보여준다', async () => {
    renderPanel(makeHost());

    expect(rowValue('Type')).toBe('RDP');
    expect(rowValue('Address')).toBe('10.0.2.181:3389');
    expect(rowValue('Port')).toBe('3389');
    // 계정은 자격증명에 딸려 있다 — 호스트 레코드에는 없다.
    expect(rowValue('Account')).toBe('CORP\\Administrator');
    expect(rowValue('Credential')).toBe('사내 관리자');
    expect(rowValue('관리 세션')).toBe('사용');
    expect(rowValue('색 품질')).toBe('16-bit');
    expect(rowValue('모든 모니터 사용')).toBe('사용');
    // 기본값이 켬인 토글은 껐을 때도 보여야 한다.
    expect(rowValue('원격 소리')).toBe('사용 안 함');
    expect(rowValue('클립보드 공유')).toBe('사용');
    // 마이크는 기본이 꺼짐이라 이 호스트에는 줄이 없어야 한다(켠 경우만 적는다).
    expect(screen.queryByText('마이크')).toBeNull();
    expect(rowValue('공유 폴더')).toBe('docs읽기 전용');
    // 신뢰한 인증서 지문은 설정한 값이 아니라 여기 넣지 않는다(접속 시 확인 화면이 보여준다).
    expect(screen.queryByText('AA:BB:CC:DD:EE:FF')).toBeNull();

    // tailnet 목록은 비동기로 도착한다.
    expect(await screen.findByText('corp-tailnet')).toBeTruthy();
  });

  // 공유 폴더는 **기기 로컬 설정**이다. 이 줄이 원격에서 어느 폴더가 보이는지 알려주는 유일한
  // 자리이므로, 실제로 붙이는 것과 다른 값을 보여주면 안 된다 — 파일이 노출되는 문제다.
  it('공유 폴더는 이 기기의 값을 보여준다 — 레코드에 남은 값이 아니라', () => {
    appStore.setState((state) => ({
      settings: {
        ...(state.settings ?? ({} as never)),
        rdpDrivesByHostId: {
          'h-rdp': [{ path: '/Users/me/here', readOnly: false }],
        },
      } as never,
    }));
    try {
      // 레코드에는 다른 기기에서 고른 경로가 남아 있다.
      renderPanel(makeHost({ drives: [{ path: '/Volumes/elsewhere', readOnly: true }] }));
      expect(rowValue('공유 폴더')).toBe('here');
      expect(screen.queryByText('elsewhere')).toBeNull();
    } finally {
      appStore.setState((state) => ({
        settings: { ...(state.settings ?? ({} as never)), rdpDrivesByHostId: {} } as never,
      }));
    }
  });

  it('이 기기에서 공유를 끄면 그 줄이 사라진다 — 레코드로 되살아나지 않는다', () => {
    appStore.setState((state) => ({
      settings: {
        ...(state.settings ?? ({} as never)),
        rdpDrivesByHostId: { 'h-rdp': [] },
      } as never,
    }));
    try {
      renderPanel(makeHost({ drives: [{ path: '/Users/me/docs', readOnly: true }] }));
      expect(screen.queryByText('공유 폴더')).toBeNull();
    } finally {
      appStore.setState((state) => ({
        settings: { ...(state.settings ?? ({} as never)), rdpDrivesByHostId: {} } as never,
      }));
    }
  });

  // 원격에 소리가 넘어가는 설정이라, 켜져 있다는 사실이 이 표에서 보여야 한다.
  it('마이크를 켰으면 그 줄을 보여준다', () => {
    renderPanel(makeHost({ microphoneEnabled: true }));

    expect(rowValue('마이크')).toBe('사용');
  });

  it('설정하지 않은 값은 기본값으로 보여주고 없는 줄은 빼낸다', () => {
    renderPanel(
      makeHost({
        secretRef: null,
        tailnetId: null,
        adminSession: null,
        audioEnabled: null,
        clipboardEnabled: false,
        colorDepth: null,
        useAllMonitors: null,
        drives: null,
        certificateFingerprint: null,
      }),
    );

    expect(rowValue('Credential')).toBe('저장 안 함 (연결 시 입력)');
    expect(rowValue('색 품질')).toBe('32-bit');
    expect(rowValue('원격 소리')).toBe('사용');
    expect(rowValue('클립보드 공유')).toBe('사용 안 함');
    expect(screen.queryByText('Account')).toBeNull();
    expect(screen.queryByText('관리 세션')).toBeNull();
    expect(screen.queryByText('모든 모니터 사용')).toBeNull();
    expect(screen.queryByText('공유 폴더')).toBeNull();
    expect(screen.queryByText('Tailnet')).toBeNull();
  });
});

// RDP 세션에는 SFTP·tmux·컨테이너가 없다. 눌러도 아무 일이 없거나(tmux 플래그는 RDP 경로에서
// 그냥 무시된다) 실패할 버튼을 띄우면 그 기능이 있는 줄로 읽힌다.
describe('HostDetailPanel — Overview Quick Actions', () => {
  it('RDP 호스트에는 SSH 세션이 필요한 버튼을 빼고 Connect·Edit 만 남긴다', () => {
    renderPanel(makeHost(), 'overview');

    expect(screen.queryByRole('button', { name: 'Open SFTP' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'TMUX Connect' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Containers' })).toBeNull();

    expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit Host' })).toBeTruthy();
  });

  it('SSH 호스트에는 그대로 보여준다', () => {
    renderPanel(makeSshHost(), 'overview');

    expect(screen.getByRole('button', { name: 'Open SFTP' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'TMUX Connect' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Containers' })).toBeTruthy();
  });
});

// 경유 계층(Tailnet·Jump Host·SSM 경유·SSH 터널)은 Overview 에도 있어야 한다 — 주소만 보면 직접
// 붙는 것처럼 보이는 종류들이다(RDP-over-SSM 은 사설 IP, SSH 점프는 최종 호스트 주소가 적힌다).
// **Connection 탭과 같은 행·같은 라벨을 쓴다** — 요약용 새 문구를 만들면 두 탭이 다른 말을 한다.
describe('HostDetailPanel — Overview 경유 계층', () => {
  it('SSM 을 거치면 Connection 탭과 같은 SSM 경유 행을 보여준다', () => {
    renderPanel(
      makeHost({
        tailnetId: null,
        awsSsm: {
          profileId: 'p-1',
          profileName: 'admin',
          region: 'ap-northeast-2',
          instanceId: 'i-0abc',
        },
      }),
      'overview',
    );

    expect(rowValue('SSM 경유')).toBe('i-0abc · ap-northeast-2 · admin');
  });

  it('tailnet 과 SSM 을 함께 쓰면 원래 순서대로 보여준다', async () => {
    renderPanel(
      makeHost({
        awsSsm: {
          profileId: 'p-1',
          profileName: 'admin',
          region: 'ap-northeast-2',
          instanceId: 'i-0abc',
        },
      }),
      'overview',
    );

    // 목록이 오기 전에는 Tailnet 행을 넣지 않는다 — 붉은 "설정 없음" 이 스치면 안 된다.
    expect(screen.queryByText('Tailnet')).toBeNull();
    expect(rowValue('SSM 경유')).toContain('i-0abc');

    // 도착하면 그 행이 SSM 경유보다 먼저 온다(Connection 탭과 같은 순서).
    expect(await screen.findByText('corp-tailnet')).toBeTruthy();
    const labels = screen
      .getAllByText(/^(Tailnet|SSM 경유)$/u)
      .map((node) => node.textContent);
    expect(labels).toEqual(['Tailnet', 'SSM 경유']);
  });

  it('점프 호스트를 거치면 Jump Host 행을 보여준다', () => {
    const jump = makeSshHost();
    const target = {
      ...makeSshHost(),
      id: 'h-target',
      label: 'app',
      jumpHostIds: [jump.id],
    } as HostRecord;

    renderPanel(target, 'overview', [target, jump]);

    expect(rowValue('Jump Host')).toBe('linuxbox');
  });

  // 다단 ProxyJump. 순서가 곧 경로이므로(첫 홉 = 직접 연결 … 마지막 = 대상 바로 앞) 뒤섞이면
  // 안 되고, 라벨도 개수에 따라 갈린다.
  it('점프 호스트가 여러 개면 순서대로 이어 붙이고 라벨을 복수로 쓴다', () => {
    const hops = ['a', 'b', 'c'].map((suffix) => ({
      ...makeSshHost(),
      id: `h-${suffix}`,
      label: `bastion-${suffix}`,
    })) as HostRecord[];
    const target = {
      ...makeSshHost(),
      id: 'h-target',
      label: 'app',
      jumpHostIds: hops.map((hop) => hop.id),
    } as HostRecord;

    renderPanel(target, 'overview', [target, ...hops]);

    expect(screen.queryByText('Jump Host')).toBeNull();
    // 칩 사이의 화살표까지 한 줄로 읽힌다 — 순서가 뒤집히면 이 문자열이 달라진다.
    expect(rowValue('Jump Hosts')).toBe('bastion-a→bastion-b→bastion-c');
  });

  // 지워진 홉에 id 를 노출하면 사용자에게 아무 뜻도 없는 문자열이 남는다. VNC 터널 행과 같은
  // 상황이므로 같은 문구를 쓴다.
  it('점프 호스트가 지워졌으면 id 대신 그 사실을 적는다', () => {
    const alive = { ...makeSshHost(), id: 'h-a', label: 'bastion-a' } as HostRecord;
    const target = {
      ...makeSshHost(),
      id: 'h-target',
      label: 'app',
      jumpHostIds: ['h-a', 'h-gone'],
    } as HostRecord;

    renderPanel(target, 'overview', [target, alive]);

    const route = rowValue('Jump Hosts');
    expect(route).toContain('삭제된 SSH 호스트');
    expect(route).not.toContain('h-gone');
  });

  it('경유하는 것이 없으면 행을 넣지 않는다', () => {
    renderPanel(makeSshHost(), 'overview');

    expect(screen.queryByText('Jump Host')).toBeNull();
    expect(screen.queryByText('Tailnet')).toBeNull();
  });
});
