import { useMemo, useState } from 'react';
import { getHostSearchText, getHostSecretRef } from '@shared';
import type { HostRecord, SecretMetadataRecord } from '@shared';
import {
  Button,
  Card,
  CardActions,
  CardMain,
  CardMeta,
  CardTitleRow,
  EmptyState,
  Input,
  PanelSection,
  SectionLabel,
} from '../ui';
import { describeSecretType } from '../lib/secret-display';
import { matchesKeyboardLayoutQuery } from '../lib/keyboard-layout-search';
import { copySavedCredentialPassword } from '../services/desktop/settings';

interface KeychainPanelProps {
  entries: SecretMetadataRecord[];
  hosts: HostRecord[];
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  onRemoveSecret: (secretRef: string) => Promise<void>;
  onEditSecret: (secretRef: string) => void;
}

function getCopyErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return '비밀번호를 복사하지 못했습니다.';
}

function buildKeychainEntrySearchText(
  entry: SecretMetadataRecord,
  linkedHosts: HostRecord[],
): string {
  return [
    entry.label,
    describeSecretType(entry),
    entry.secretRef,
    ...linkedHosts.flatMap((host) => getHostSearchText(host)),
  ].join(' ');
}

export function KeychainPanel({
  entries,
  hosts,
  searchQuery,
  onSearchQueryChange,
  onRemoveSecret,
  onEditSecret,
}: KeychainPanelProps) {
  const [copyingSecretRef, setCopyingSecretRef] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<{
    tone: 'success' | 'danger';
    message: string;
  } | null>(null);

  const handleCopyPassword = async (secretRef: string) => {
    setCopyingSecretRef(secretRef);
    setCopyStatus(null);
    try {
      await copySavedCredentialPassword(secretRef);
      setCopyStatus({
        tone: 'success',
        message: '비밀번호를 클립보드에 복사했습니다.',
      });
    } catch (error) {
      setCopyStatus({
        tone: 'danger',
        message: getCopyErrorMessage(error),
      });
    } finally {
      setCopyingSecretRef(null);
    }
  };

  const hostsBySecretRef = useMemo(() => {
    const nextHostsBySecretRef = new Map<string, HostRecord[]>();
    hosts.forEach((host) => {
      const secretRef = getHostSecretRef(host);
      if (!secretRef) {
        return;
      }
      const linkedHosts = nextHostsBySecretRef.get(secretRef) ?? [];
      linkedHosts.push(host);
      nextHostsBySecretRef.set(secretRef, linkedHosts);
    });
    return nextHostsBySecretRef;
  }, [hosts]);

  const visibleEntries = useMemo(() => {
    if (searchQuery.trim().length === 0) {
      return entries;
    }

    return entries.filter((entry) =>
      matchesKeyboardLayoutQuery(
        buildKeychainEntrySearchText(entry, hostsBySecretRef.get(entry.secretRef) ?? []),
        searchQuery,
      ),
    );
  }, [entries, hostsBySecretRef, searchQuery]);

  return (
    <div className="flex flex-col gap-[1.05rem]">
      <div className="flex items-end justify-between gap-4 px-0 pt-1 pb-2">
        <div>
          <SectionLabel>Saved Credentials</SectionLabel>
          <h2 className="m-0">Saved Credentials</h2>
          <p className="mt-2 max-w-[48rem] text-[var(--text-soft)]">
            호스트가 사용하는 비밀번호, 패스프레이즈, 개인키, SSH 인증서를 안전하게 저장하고 연결 상태를 관리합니다.
          </p>
        </div>
      </div>

      {entries.length > 0 ? (
        <Input
          type="search"
          aria-label="Search saved credentials"
          placeholder="Search saved credentials"
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.target.value)}
        />
      ) : null}

      {copyStatus ? (
        <div
          role={copyStatus.tone === 'danger' ? 'alert' : 'status'}
          className={
            copyStatus.tone === 'danger'
              ? 'rounded-[14px] border border-[color-mix(in_srgb,var(--danger-text)_24%,var(--border))] bg-[var(--danger-bg)] px-4 py-3 text-sm font-semibold text-[var(--danger-text)]'
              : 'rounded-[14px] border border-[color-mix(in_srgb,var(--success-text)_24%,var(--border))] bg-[var(--success-bg)] px-4 py-3 text-sm font-semibold text-[var(--success-text)]'
          }
        >
          {copyStatus.message}
        </div>
      ) : null}

      <PanelSection>
        {entries.length === 0 ? (
          <EmptyState
            title="저장된 인증 정보가 없습니다."
            description="호스트를 저장할 때 인증 정보를 저장하면 이 목록에 표시됩니다."
          />
        ) : visibleEntries.length === 0 ? (
          <EmptyState
            title="검색 결과가 없습니다."
            description="검색어를 지우거나 다른 인증 정보로 다시 찾아보세요."
          />
        ) : (
          visibleEntries.map((entry) => (
            <Card key={entry.secretRef}>
              <CardMain>
                <CardTitleRow>
                  <strong>{entry.label}</strong>
                </CardTitleRow>
                <CardMeta>
                  <span>{describeSecretType(entry)}</span>
                  <span>{entry.linkedHostCount}개 호스트에서 사용 중</span>
                  <span>{new Date(entry.updatedAt).toLocaleString('ko-KR')}</span>
                </CardMeta>
              </CardMain>
              <CardActions>
                {entry.hasPassword ? (
                  <Button
                    variant="secondary"
                    disabled={copyingSecretRef === entry.secretRef}
                    onClick={() => void handleCopyPassword(entry.secretRef)}
                  >
                    {copyingSecretRef === entry.secretRef ? '복사 중...' : '비밀번호 복사'}
                  </Button>
                ) : null}
                <Button variant="secondary" onClick={() => onEditSecret(entry.secretRef)}>
                  편집
                </Button>
                <Button variant="danger" onClick={() => void onRemoveSecret(entry.secretRef)}>
                  삭제
                </Button>
              </CardActions>
            </Card>
          ))
        )}
      </PanelSection>
    </div>
  );
}
