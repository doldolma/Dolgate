import { useEffect, useState } from 'react';
import { DialogBackdrop } from './DialogBackdrop';
import { Button, FieldGroup, Input, ModalBody, ModalFooter, ModalHeader, ModalShell, SectionLabel } from '../ui';
import { useTranslation } from 'react-i18next';

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
  const { t: translate } = useTranslation();
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
            <h3 id="aws-sftp-config-retry-title">{translate('awsSftpRetry.title', { label: request.hostLabel })}</h3>
          </div>
        </ModalHeader>
        <ModalBody className="grid gap-4">
          <p className="text-[0.9rem] leading-[1.6] text-[var(--text-soft)]">{request.message}</p>
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
            className="self-start border-0 bg-transparent p-0 text-[0.9rem] font-semibold text-[var(--accent-strong)]"
            onClick={() => setShowAdvanced((current) => !current)}
          >
            {translate(showAdvanced ? 'awsSftpRetry.hideAdvanced' : 'awsSftpRetry.advanced')}
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
            {translate('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={submitting}
            onClick={async () => {
              const trimmedUsername = username.trim();
              if (!trimmedUsername) {
                setError(translate('awsSftpRetry.usernameRequired'));
                return;
              }
              if (!Number.isInteger(port) || port < 1 || port > 65535) {
                setError(translate('awsSftpRetry.portRequired'));
                return;
              }
              setSubmitting(true);
              try {
                await onSubmit({ username: trimmedUsername, port });
              } catch (submitError) {
                setError(submitError instanceof Error ? submitError.message : translate('awsSftpRetry.retryFailed'));
                setSubmitting(false);
              }
            }}
          >
            {translate('awsSftpRetry.retry')}
          </Button>
        </ModalFooter>
      </ModalShell>
    </DialogBackdrop>
  );
}
