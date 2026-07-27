import { useEffect, useState } from "react";
import { DialogBackdrop } from "./DialogBackdrop";
import { Button, FieldGroup, Input, ModalBody, ModalFooter, ModalHeader, ModalShell, SectionLabel } from '../ui';
import { useTranslation } from "react-i18next";
import { t } from '../i18n';

export interface MissingUsernameDialogRequest {
  hostLabel: string;
  source: "ssh" | "sftp" | "containers" | "containerShell" | "portForward";
}

interface MissingUsernameDialogProps {
  request: MissingUsernameDialogRequest | null;
  onClose: () => void;
  onSubmit: (input: { username: string }) => Promise<void>;
}

function resolveMessage(source: MissingUsernameDialogRequest["source"]): string {
  switch (source) {
    case "sftp":
      return t('missingUsername.sftp');
    case "containers":
      return t('missingUsername.containers');
    case "containerShell":
      return t('missingUsername.containerShell');
    case "portForward":
      return t('missingUsername.portForward');
    default:
      return t('missingUsername.ssh');
  }
}

export function MissingUsernameDialog({
  request,
  onClose,
  onSubmit,
}: MissingUsernameDialogProps) {
  const { t: translate } = useTranslation();
  const [username, setUsername] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setUsername("");
    setSubmitting(false);
    setError(null);
  }, [request]);

  if (!request) {
    return null;
  }

  return (
    <DialogBackdrop dismissOnBackdrop={false}>
      <ModalShell
        role="dialog"
        aria-modal="true"
        aria-labelledby="missing-username-title"
      >
        <ModalHeader>
          <div>
            <SectionLabel>SSH Username</SectionLabel>
            <h3 id="missing-username-title">
              {translate('missingUsername.prompt', { label: request.hostLabel })}
            </h3>
          </div>
        </ModalHeader>
        <ModalBody className="grid gap-4">
          <p className="text-[0.9rem] leading-[1.6] text-[var(--text-soft)]">
            {resolveMessage(request.source)}
          </p>
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
          {error ? (
            <p className="text-[0.9rem] text-[var(--danger-text)]">{error}</p>
          ) : null}
        </ModalBody>
        <ModalFooter>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            {translate('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={submitting}
            onClick={async () => {
              if (!username.trim()) {
                setError(translate('sessionStore.usernameRequired'));
                return;
              }
              setSubmitting(true);
              try {
                await onSubmit({ username: username.trim() });
              } catch (submitError) {
                setError(
                  submitError instanceof Error
                    ? submitError.message
                    : translate('missingUsername.saveFailed'),
                );
                setSubmitting(false);
              }
            }}
          >
            {translate('missingUsername.submit')}
          </Button>
        </ModalFooter>
      </ModalShell>
    </DialogBackdrop>
  );
}
