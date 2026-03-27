import { useEffect, useState } from 'react';
import { DialogBackdrop } from './DialogBackdrop';

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
      <div className="modal-card credential-retry-dialog" role="dialog" aria-modal="true" aria-labelledby="aws-sftp-config-retry-title">
        <div className="modal-card__header">
          <div>
            <div className="eyebrow">AWS SFTP</div>
            <h3 id="aws-sftp-config-retry-title">{request.hostLabel} SSH 설정을 확인해 주세요.</h3>
          </div>
        </div>
        <div className="modal-card__body">
          <p className="credential-retry-dialog__message">{request.message}</p>
          <label className="credential-retry-dialog__field">
            <span>SSH Username</span>
            <input
              type="text"
              autoFocus
              value={username}
              onChange={(event) => {
                setUsername(event.target.value);
                setError(null);
              }}
              placeholder="ubuntu"
            />
          </label>
          <button
            type="button"
            className="text-button"
            onClick={() => setShowAdvanced((current) => !current)}
          >
            {showAdvanced ? '고급 옵션 숨기기' : '고급 옵션'}
          </button>
          {showAdvanced ? (
            <label className="credential-retry-dialog__field">
              <span>SSH Port</span>
              <input
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(event) => {
                  setPort(Number(event.target.value) || 22);
                  setError(null);
                }}
              />
            </label>
          ) : null}
          {error ? <p className="credential-retry-dialog__error">{error}</p> : null}
        </div>
        <div className="modal-card__footer">
          <button type="button" className="secondary-button" onClick={onClose} disabled={submitting}>
            취소
          </button>
          <button
            type="button"
            className="primary-button"
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
          </button>
        </div>
      </div>
    </DialogBackdrop>
  );
}
