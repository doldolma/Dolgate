import { useEffect, useState } from 'react';
import type { LinkedHostSummary } from '@shared';

export type SecretEditMode = 'update-shared' | 'clone-for-host';
export type SecretCredentialKind = 'password' | 'passphrase';

export interface SecretEditDialogRequest {
  source: 'host' | 'keychain';
  secretRef: string;
  label: string;
  credentialKind: SecretCredentialKind;
  linkedHosts: LinkedHostSummary[];
  initialMode: SecretEditMode;
  initialHostId?: string | null;
}

interface SecretEditDialogProps {
  request: SecretEditDialogRequest | null;
  onClose: () => void;
  onSubmit: (input: {
    mode: SecretEditMode;
    secretRef: string;
    hostId: string | null;
    secrets: { password?: string; passphrase?: string };
  }) => Promise<void>;
}

export function SecretEditDialog({ request, onClose, onSubmit }: SecretEditDialogProps) {
  const [mode, setMode] = useState<SecretEditMode>('update-shared');
  const [value, setValue] = useState('');
  const [targetHostId, setTargetHostId] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!request) {
      setMode('update-shared');
      setValue('');
      setTargetHostId('');
      setIsSubmitting(false);
      setError(null);
      return;
    }
    setMode(request.initialMode);
    setValue('');
    setTargetHostId(request.initialHostId ?? request.linkedHosts[0]?.id ?? '');
    setIsSubmitting(false);
    setError(null);
  }, [request]);

  if (!request) {
    return null;
  }

  const credentialLabel = request.credentialKind === 'password' ? '비밀번호' : 'Passphrase';
  const linkedHostCount = request.linkedHosts.length;
  const needsHostPicker = mode === 'clone-for-host' && request.source === 'keychain' && linkedHostCount > 1;
  const canSubmit = value.trim().length > 0 && (mode === 'update-shared' || Boolean(targetHostId));

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal-card secret-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="secret-edit-title">
        <div className="modal-card__header">
          <div>
            <div className="eyebrow">Keychain</div>
            <h3 id="secret-edit-title">{credentialLabel} 변경</h3>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close secret editor">
            ×
          </button>
        </div>
        <div className="modal-card__body">
          <p className="secret-edit-dialog__description">
            <strong>{request.label}</strong> 키체인 항목의 {credentialLabel.toLowerCase()}를 새 값으로 바꿉니다. 현재 값은 표시하지 않습니다.
          </p>

          <div className="secret-edit-dialog__scope">
            <button
              type="button"
              className={`secondary-button ${mode === 'clone-for-host' ? 'active' : ''}`}
              onClick={() => setMode('clone-for-host')}
            >
              이 호스트만 새 secret으로 분리
            </button>
            <button
              type="button"
              className={`secondary-button ${mode === 'update-shared' ? 'active' : ''}`}
              onClick={() => setMode('update-shared')}
            >
              공유 항목 전체 변경
            </button>
          </div>

          {mode === 'update-shared' ? (
            <p className="form-note">이 secret을 쓰는 {linkedHostCount}개 호스트가 모두 새 {credentialLabel.toLowerCase()}를 사용합니다.</p>
          ) : null}

          {mode === 'clone-for-host' && request.source === 'host' && request.initialHostId ? (
            <p className="form-note">현재 편집 중인 호스트만 새 secret으로 분리하고, 다른 호스트들은 기존 secret을 유지합니다.</p>
          ) : null}

          {needsHostPicker ? (
            <label className="form-field">
              <span>분리할 호스트</span>
              <select value={targetHostId} onChange={(event) => setTargetHostId(event.target.value)}>
                {request.linkedHosts.map((host) => (
                  <option key={host.id} value={host.id}>
                    {host.label} ({host.username}@{host.hostname})
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <label className="form-field">
            <span>새 {credentialLabel}</span>
            <input
              type="password"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={`${credentialLabel}를 입력하세요`}
              autoFocus
            />
          </label>

          {error ? <p className="form-error">{error}</p> : null}
        </div>
        <div className="modal-card__footer">
          <button type="button" className="secondary-button" onClick={onClose} disabled={isSubmitting}>
            취소
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!canSubmit || isSubmitting}
            onClick={async () => {
              setIsSubmitting(true);
              setError(null);
              try {
                await onSubmit({
                  mode,
                  secretRef: request.secretRef,
                  hostId: mode === 'clone-for-host' ? request.initialHostId ?? targetHostId : null,
                  secrets: request.credentialKind === 'password' ? { password: value } : { passphrase: value }
                });
                onClose();
              } catch (submitError) {
                setError(submitError instanceof Error ? submitError.message : 'secret 수정 중 오류가 발생했습니다.');
              } finally {
                setIsSubmitting(false);
              }
            }}
          >
            {mode === 'update-shared' ? '공유 secret 저장' : '호스트 전용 secret 생성'}
          </button>
        </div>
      </div>
    </div>
  );
}
