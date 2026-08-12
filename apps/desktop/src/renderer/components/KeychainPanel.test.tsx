import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { HostRecord, SecretMetadataRecord } from '@shared';

// 비밀번호 복사는 preload 를 타므로 여기서는 부른 적 없다는 것만 보장한다.
vi.mock('../services/desktop/settings', () => ({
  copySavedCredentialPassword: vi.fn().mockResolvedValue(undefined),
}));

const { KeychainPanel } = await import('./KeychainPanel');

function secret(overrides: Partial<SecretMetadataRecord>): SecretMetadataRecord {
  return {
    secretRef: 'secret:1',
    label: 'cred',
    hasPassword: true,
    hasPassphrase: false,
    hasManagedPrivateKey: false,
    hasCertificate: false,
    linkedHostCount: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as SecretMetadataRecord;
}

// secretRef·라벨에는 종류 이름을 넣지 않는다. 넣으면 검색 테스트가 그 문자열로 통과해서
// 배지가 검색어에 실린다는 사실을 증명하지 못한다.
const ENTRIES: SecretMetadataRecord[] = [
  secret({ secretRef: 'secret:aa11', label: 'bastion login', kind: 'ssh' }),
  secret({ secretRef: 'secret:bb22', label: 'win admin', kind: 'rdp' }),
  secret({ secretRef: 'secret:cc33', label: 'lab console', kind: 'vnc' }),
  // 이 필드가 생기기 전에 만든 항목. SSH 로 본다.
  secret({ secretRef: 'secret:dd44', label: 'old cred', kind: null }),
];

function renderPanel(
  entries: SecretMetadataRecord[] = ENTRIES,
  searchQuery = '',
  hosts: HostRecord[] = [],
) {
  const onSearchQueryChange = vi.fn();
  render(
    <KeychainPanel
      entries={entries}
      hosts={hosts}
      searchQuery={searchQuery}
      onSearchQueryChange={onSearchQueryChange}
      onRemoveSecret={vi.fn().mockResolvedValue(undefined)}
      onEditSecret={vi.fn()}
      onGenerateSshKey={vi.fn().mockResolvedValue({} as never)}
      onCopySshPublicKey={vi.fn().mockResolvedValue(undefined)}
      onInstallSshPublicKey={vi.fn().mockResolvedValue({} as never)}
    />,
  );
  return { onSearchQueryChange };
}

/** 라벨이 속한 카드. 배지가 그 항목의 것인지 확인하려면 카드 단위로 봐야 한다. */
function cardOf(label: string): HTMLElement {
  const card = screen.getByText(label).closest('article, li, div[class*="rounded"]');
  if (!card) {
    throw new Error(`card not found for ${label}`);
  }
  return card as HTMLElement;
}

describe('KeychainPanel 자격증명 종류 표시', () => {
  // 비밀번호만 든 항목은 세 종류가 모두 'Password' 로 보였다 — 어느 프로토콜용인지 알 방법이 없었다.
  it('항목마다 프로토콜 배지를 붙인다', () => {
    renderPanel();

    expect(within(cardOf('bastion login')).getByText('SSH')).toBeInTheDocument();
    expect(within(cardOf('win admin')).getByText('RDP')).toBeInTheDocument();
    expect(within(cardOf('lab console')).getByText('VNC')).toBeInTheDocument();
    // 종류를 잃은 항목도 빈 배지가 아니라 SSH 로 나온다.
    expect(within(cardOf('old cred')).getByText('SSH')).toBeInTheDocument();
  });

  it('담긴 자격증명 설명은 그대로 남는다', () => {
    renderPanel();

    // 배지가 종류를 말하고 이 줄은 내용물을 말한다 — 둘 다 필요하다.
    expect(within(cardOf('win admin')).getByText('Password')).toBeInTheDocument();
  });

  // 목록이 길어지면 종류로 좁히는 것이 가장 빠르다.
  it('종류로 검색된다', () => {
    renderPanel(ENTRIES, 'vnc');

    expect(screen.getByText('lab console')).toBeInTheDocument();
    expect(screen.queryByText('win admin')).not.toBeInTheDocument();
    expect(screen.queryByText('bastion login')).not.toBeInTheDocument();
  });

  it('검색어가 라벨에도 계속 걸린다', () => {
    renderPanel(ENTRIES, 'admin');

    expect(screen.getByText('win admin')).toBeInTheDocument();
    expect(screen.queryByText('lab console')).not.toBeInTheDocument();
  });
});
