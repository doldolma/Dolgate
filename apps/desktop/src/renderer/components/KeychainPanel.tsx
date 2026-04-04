import type { SecretMetadataRecord } from '@shared';
import { Button, Card, CardActions, CardMain, CardMeta, CardTitleRow, EmptyState, SectionLabel } from '../ui';

interface KeychainPanelProps {
  entries: SecretMetadataRecord[];
  onRemoveSecret: (secretRef: string) => Promise<void>;
  onEditSecret: (secretRef: string, credentialKind: 'password' | 'passphrase') => void;
}

export function KeychainPanel({ entries, onRemoveSecret, onEditSecret }: KeychainPanelProps) {
  return (
    <div className="flex flex-col gap-[1.05rem]">
      <div className="flex items-end justify-between gap-4 px-0 pt-1 pb-2">
        <div>
          <SectionLabel>Secrets</SectionLabel>
          <h2 className="m-0">Secrets</h2>
          <p className="mt-2 max-w-[48rem] text-[var(--text-soft)]">
            원문 비밀번호와 패스프레이즈는 표시하지 않고, 저장 여부와 삭제만 관리합니다.
          </p>
        </div>
      </div>

      <div className="operations-list">
        {entries.length === 0 ? (
          <EmptyState
            title="저장된 secret이 없습니다."
            description="호스트 저장 시 새 secret을 만들거나 기존 secret을 연결하면 이 목록에 표시됩니다."
          />
        ) : (
          entries.map((entry) => (
            <Card key={entry.secretRef}>
              <CardMain>
                <CardTitleRow>
                  <strong>{entry.label}</strong>
                </CardTitleRow>
                <CardMeta>
                  <span>{entry.linkedHostCount}개 호스트에서 사용 중</span>
                  <span>{entry.hasPassword ? 'Password saved' : 'No password'}</span>
                  <span>{entry.hasPassphrase ? 'Passphrase saved' : 'No passphrase'}</span>
                  <span>{new Date(entry.updatedAt).toLocaleString('ko-KR')}</span>
                </CardMeta>
              </CardMain>
              <CardActions>
                {entry.hasPassword ? (
                  <Button variant="secondary" onClick={() => onEditSecret(entry.secretRef, 'password')}>
                    Edit password
                  </Button>
                ) : null}
                {entry.hasPassphrase ? (
                  <Button variant="secondary" onClick={() => onEditSecret(entry.secretRef, 'passphrase')}>
                    Edit passphrase
                  </Button>
                ) : null}
                <Button variant="danger" onClick={() => void onRemoveSecret(entry.secretRef)}>
                  Delete secret
                </Button>
              </CardActions>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
