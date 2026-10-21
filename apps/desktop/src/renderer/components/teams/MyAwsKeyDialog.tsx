import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AwsProfileMissingMyKey } from '@shared';
import { updateAwsProfile } from '../../services/desktop/imports';
import { useAppStore } from '../../store/appStore';
import { teamOfVault } from '../../lib/vault-groups';
import { Button, FieldGroup, Input } from '../../ui';
import { MyKeyField } from './MyKeyField';
import { TeamDialogError, TeamDialogFrame } from './TeamDialogFrame';
import { useDialogAction } from './useDialogAction';
import { VaultChip } from './VaultMark';

interface MyAwsKeyDialogProps {
  missing: AwsProfileMissingMyKey;
  onClose: () => void;
  /** 저장(메인이 STS 로 확인한 뒤)이 끝났다 — 부르는 쪽이 다시 붙는다. */
  onSaved: () => void;
}

/**
 * 키 없는 팀 정적 AWS 프로필에 내 키를 넣는 창(후보 M3) — 연결 실패 화면의 "내 키 넣기". 설정으로 보내지 않고 그
 * 자리에서 넣는다. 리전은 보내지 않는다 — 팀 설정이라 그대로 둔다(메인이 지금 리전을 쓴다).
 */
export function MyAwsKeyDialog({ missing, onClose, onSaved }: MyAwsKeyDialogProps) {
  const { t: translate } = useTranslation();
  const vaultIndex = useAppStore((state) => state.vaultIndex);
  const team = teamOfVault(vaultIndex, missing.teamId);
  const { busy, error, run } = useDialogAction('teams.myKey.saveFailed');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');

  const save = async () => {
    const saved = await run(() =>
      updateAwsProfile({
        profileName: missing.profileName,
        accessKeyId,
        secretAccessKey,
        vaultId: missing.teamId,
      }),
    );
    if (saved) {
      onSaved();
    }
  };

  return (
    <TeamDialogFrame
      section="AWS"
      title={
        <span className="inline-flex flex-wrap items-center gap-2">
          {translate('teams.myKey.dialogTitle', { profile: missing.profileName })}
          {team ? <VaultChip team={team} /> : null}
        </span>
      }
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {translate('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void save()}
            disabled={busy || !accessKeyId.trim() || !secretAccessKey.trim()}
          >
            {translate('common.save')}
          </Button>
        </>
      }
    >
      <MyKeyField label="My Access Key" hint={translate('teams.myKey.awsHint')}>
        <Input
          aria-label="My Access Key"
          value={accessKeyId}
          onChange={(event) => setAccessKeyId(event.target.value)}
          placeholder="AKIA..."
          disabled={busy}
          autoFocus
        />
      </MyKeyField>
      <FieldGroup label="My Secret">
        <Input
          aria-label="My Secret"
          type="password"
          value={secretAccessKey}
          onChange={(event) => setSecretAccessKey(event.target.value)}
          placeholder="AWS secret access key"
          disabled={busy}
        />
      </FieldGroup>
      <TeamDialogError message={error} />
    </TeamDialogFrame>
  );
}
