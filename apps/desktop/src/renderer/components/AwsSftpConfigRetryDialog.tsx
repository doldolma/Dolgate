import { useEffect, useState } from 'react';
import { DialogBackdrop } from './DialogBackdrop';
import { Button, FieldGroup, Input, ModalBody, ModalFooter, ModalHeader, ModalShell, SectionLabel } from '../ui';

export interface AwsSftpConfigRetryDialogRequest {
  hostLabel: string;
  message: string;
  suggestedUsername: string;
  suggestedPort: number;
}

interface AwsSftpConfigRetryDialogProps {
  request: AwsSftpConfigRetryDialogRequest | null;
  onClose: () => void;
  onSubmit: (input: { username: string; port: number }) => Promise<void>;
}

export function AwsSftpConfigRetryDialog({ request, onClose, onSubmit }: AwsSftpConfigRetryDialogProps) {
  const [username, setUsername] = useState('');
  const [port, setPort] = useState(22);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setUsername(request?.suggestedUsername ?? '');
    setPort(request?.suggestedPort ?? 22);
    setShowAdvanced(false);
    setSubmitting(false);
    setError(null);
  }, [request]);

  if (!request) {
    return null;
  }

  return (
    <DialogBackdrop dismissOnBackdrop={false}>
      <ModalShell role="dialog" aria-modal="true" aria-labelledby="aws-sftp-config-retry-title">
        <ModalHeader>
          <div>
            <SectionLabel>AWS SFTP</SectionLabel>
            <h3 id="aws-sftp-config-retry-title">{request.hostLabel} SSH 설정을 확인해 주세요.</h3>
          </div>
        </ModalHeader>
        <ModalBody className="grid gap-4">
          <p className="text-[0.95rem] leading-[1.6] text-[var(--text-soft)]">{request.message}</p>
          <FieldGroup label="SSH Username">
            <Input
              type="text"
              autoFocus
              value={username}
              onChange={(event) => {
                setUsername(event.target.value);
                setError(null);
              }}
              placeholder="ubuntu"
            />
          </FieldGroup>
          <button
            type="button"
            className="self-start border-0 bg-transparent p-0 text-[0.92rem] font-semibold text-[var(--accent-strong)]"
            onClick={() => setShowAdvanced((current) => !current)}
          >
            {showAdvanced ? '고급 옵션 숨기기' : '고급 옵션'}
          </button>
          {showAdvanced ? (
            <FieldGroup label="SSH Port">
              <Input
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(event) => {
                  setPort(Number(event.target.value) || 22);
                  setError(null);
                }}
              />
            </FieldGroup>
          ) : null}
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
              const trimmedUsername = username.trim();
              if (!trimmedUsername) {
                setError('SSH Username을 입력해 주세요.');
                return;
              }
              if (!Number.isInteger(port) || port < 1 || port > 65535) {
                setError('올바른 SSH Port를 입력해 주세요.');
                return;
              }
              setSubmitting(true);
              try {
                await onSubmit({ username: trimmedUsername, port });
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
