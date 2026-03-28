import { useEffect, useState } from "react";
import { DialogBackdrop } from "./DialogBackdrop";

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
      return "SFTP 연결 전에 SSH 사용자명을 입력해 주세요. 입력한 사용자명은 이 호스트에 저장됩니다.";
    case "containers":
      return "컨테이너 연결 전에 SSH 사용자명을 입력해 주세요. 입력한 사용자명은 이 호스트에 저장됩니다.";
    case "containerShell":
      return "컨테이너 셸 연결 전에 SSH 사용자명을 입력해 주세요. 입력한 사용자명은 이 호스트에 저장됩니다.";
    case "portForward":
      return "포트 포워딩을 시작하기 전에 SSH 사용자명을 입력해 주세요. 입력한 사용자명은 이 호스트에 저장됩니다.";
    default:
      return "SSH 연결 전에 사용자명을 입력해 주세요. 입력한 사용자명은 이 호스트에 저장됩니다.";
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
      <div
        className="modal-card credential-retry-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="missing-username-title"
      >
        <div className="modal-card__header">
          <div>
            <div className="eyebrow">SSH Username</div>
            <h3 id="missing-username-title">
              {request.hostLabel} 사용자명을 입력해 주세요.
            </h3>
          </div>
        </div>
        <div className="modal-card__body">
          <p className="credential-retry-dialog__message">
            {resolveMessage(request.source)}
          </p>
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
          {error ? (
            <p className="credential-retry-dialog__error">{error}</p>
          ) : null}
        </div>
        <div className="modal-card__footer">
          <button
            type="button"
            className="secondary-button"
            onClick={onClose}
            disabled={submitting}
          >
            취소
          </button>
          <button
            type="button"
            className="primary-button"
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
          </button>
        </div>
      </div>
    </DialogBackdrop>
  );
}
