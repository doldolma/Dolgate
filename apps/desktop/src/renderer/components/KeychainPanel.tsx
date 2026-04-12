import type { SecretMetadataRecord } from '@shared';
import {
  Button,
  Card,
  CardActions,
  CardMain,
  CardMeta,
  CardTitleRow,
  EmptyState,
  PanelSection,
  SectionLabel,
} from '../ui';
import { describeSecretType } from '../lib/secret-display';

interface KeychainPanelProps {
  entries: SecretMetadataRecord[];
  onRemoveSecret: (secretRef: string) => Promise<void>;
  onEditSecret: (secretRef: string) => void;
}

export function KeychainPanel({ entries, onRemoveSecret, onEditSecret }: KeychainPanelProps) {
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

      <PanelSection>
        {entries.length === 0 ? (
          <EmptyState
            title="저장된 인증 정보가 없습니다."
            description="호스트를 저장할 때 인증 정보를 저장하면 이 목록에 표시됩니다."
          />
        ) : (
          entries.map((entry) => (
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
