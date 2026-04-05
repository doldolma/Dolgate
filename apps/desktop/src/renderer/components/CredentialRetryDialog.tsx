import { useEffect, useState } from 'react';
import type { HostSecretInput } from '@shared';
import { DialogBackdrop } from './DialogBackdrop';
import { Button, FieldGroup, Input, ModalBody, ModalFooter, ModalHeader, ModalShell, SectionLabel } from '../ui';

export interface CredentialRetryDialogRequest {
  hostId: string;
  hostLabel: string;
  source: 'ssh' | 'sftp';
  credentialKind: 'password' | 'passphrase';
  message: string;
}

interface CredentialRetryDialogProps {
  request: CredentialRetryDialogRequest | null;
  onClose: () => void;
  onSubmit: (secrets: HostSecretInput) => Promise<void>;
}

export function CredentialRetryDialog({ request, onClose, onSubmit }: CredentialRetryDialogProps) {
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValue('');
    setSubmitting(false);
    setError(null);
  }, [request]);

  if (!request) {
    return null;
  }

  const isPassword = request.credentialKind === 'password';

  return (
    <DialogBackdrop dismissOnBackdrop={false}>
      <ModalShell role="dialog" aria-modal="true" aria-labelledby="credential-retry-title">
        <ModalHeader>
          <div>
            <SectionLabel>{request.source === 'sftp' ? 'SFTP Retry' : 'SSH Retry'}</SectionLabel>
            <h3 id="credential-retry-title">{request.hostLabel} 인증을 다시 입력해 주세요.</h3>
          </div>
        </ModalHeader>
        <ModalBody className="grid gap-4">
          <p className="text-[0.95rem] leading-[1.6] text-[var(--text-soft)]">{request.message}</p>
          <FieldGroup label={isPassword ? 'Password' : 'Passphrase'}>
            <Input
              type="password"
              autoFocus
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                setError(null);
              }}
              placeholder={isPassword ? 'Enter password' : 'Enter passphrase'}
            />
          </FieldGroup>
          {error ? <p className="text-[0.9rem] text-[var(--danger-text)]">{error}</p> : null}
        </ModalBody>
        <ModalFooter>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            취소
          </Button>
          <Button
            variant="primary"
            disabled={submitting}
            onClick={async () => {
              if (!value.trim()) {
                setError(isPassword ? '비밀번호를 입력해 주세요.' : 'passphrase를 입력해 주세요.');
                return;
              }
              setSubmitting(true);
              try {
                await onSubmit(isPassword ? { password: value } : { passphrase: value });
              } catch (submitError) {
                setError(submitError instanceof Error ? submitError.message : '다시 시도하지 못했습니다.');
                setSubmitting(false);
              }
            }}
          >
            다시 시도
          </Button>
        </ModalFooter>
      </ModalShell>
    </DialogBackdrop>
  );
}
