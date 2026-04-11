import { useEffect, useState } from "react";
import { DialogBackdrop } from "./DialogBackdrop";
import { Button, FieldGroup, Input, ModalBody, ModalFooter, ModalHeader, ModalShell, SectionLabel } from '../ui';

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
      return "이 호스트에는 아직 저장된 SSH 사용자명이 없습니다. SFTP 연결을 계속하려면 사용자명을 입력해 주세요. 지금 입력한 값은 이 호스트에 저장되며, 다음 연결부터 자동으로 재사용합니다.";
    case "containers":
      return "이 호스트에는 아직 저장된 SSH 사용자명이 없습니다. 컨테이너 연결을 계속하려면 사용자명을 입력해 주세요. 지금 입력한 값은 이 호스트에 저장되며, 다음 연결부터 자동으로 재사용합니다.";
    case "containerShell":
      return "이 호스트에는 아직 저장된 SSH 사용자명이 없습니다. 컨테이너 셸 연결을 계속하려면 사용자명을 입력해 주세요. 지금 입력한 값은 이 호스트에 저장되며, 다음 연결부터 자동으로 재사용합니다.";
    case "portForward":
      return "이 호스트에는 아직 저장된 SSH 사용자명이 없습니다. 포트 포워딩을 시작하려면 사용자명을 입력해 주세요. 지금 입력한 값은 이 호스트에 저장되며, 다음 연결부터 자동으로 재사용합니다.";
    default:
      return "이 호스트에는 아직 저장된 SSH 사용자명이 없습니다. SSH 연결을 계속하려면 사용자명을 입력해 주세요. 지금 입력한 값은 이 호스트에 저장되며, 다음 연결부터 자동으로 재사용합니다.";
  }
}

export function MissingUsernameDialog({
  request,
  onClose,
  onSubmit,
}: MissingUsernameDialogProps) {
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
              {request.hostLabel} 사용자명을 입력해 주세요.
            </h3>
          </div>
        </ModalHeader>
        <ModalBody className="grid gap-4">
          <p className="text-[0.95rem] leading-[1.6] text-[var(--text-soft)]">
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
            취소
          </Button>
          <Button
            variant="primary"
            disabled={submitting}
            onClick={async () => {
              if (!username.trim()) {
                setError("사용자명을 입력해 주세요.");
                return;
              }
              setSubmitting(true);
              try {
                await onSubmit({ username: username.trim() });
              } catch (submitError) {
                setError(
                  submitError instanceof Error
                    ? submitError.message
                    : "사용자명을 저장하지 못했습니다.",
                );
                setSubmitting(false);
              }
            }}
          >
            저장 후 계속
          </Button>
        </ModalFooter>
      </ModalShell>
    </DialogBackdrop>
  );
}
