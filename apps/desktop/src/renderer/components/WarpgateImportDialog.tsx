import { useEffect, useRef, useState } from "react";
import type {
  HostDraft,
  WarpgateConnectionInfo,
  WarpgateImportEvent,
  WarpgateImportStatus,
  WarpgateTargetSummary,
} from "@shared";
import { DialogBackdrop } from "./DialogBackdrop";

interface WarpgateImportDialogProps {
  open: boolean;
  currentGroupPath: string | null;
  onClose: () => void;
  onImport: (draft: HostDraft) => Promise<void>;
}

function normalizeBaseUrl(value: string): URL | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    try {
      parsed = new URL(`https://${trimmed}`);
    } catch {
      return null;
    }
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return null;
  }

  return parsed;
}

function getStatusMessage(status: WarpgateImportStatus | null): string | null {
  if (status === "opening-browser") {
    return "인증 창을 여는 중";
  }
  if (status === "waiting-for-login") {
    return "Warpgate 로그인 완료를 기다리는 중";
  }
  if (status === "loading-targets") {
    return "SSH target 목록을 불러오는 중";
  }
  return null;
}

export function WarpgateImportDialog({
  open,
  currentGroupPath,
  onClose,
  onImport,
}: WarpgateImportDialogProps) {
  const [baseUrl, setBaseUrl] = useState("");
  const [fallbackUsername, setFallbackUsername] = useState("");
  const [targets, setTargets] = useState<WarpgateTargetSummary[]>([]);
  const [savingTargetId, setSavingTargetId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<WarpgateImportStatus | null>(null);
  const [connectionInfo, setConnectionInfo] =
    useState<WarpgateConnectionInfo | null>(null);
  const [activeAttemptId, setActiveAttemptId] = useState<string | null>(null);
  const activeAttemptIdRef = useRef<string | null>(null);

  useEffect(() => {
    activeAttemptIdRef.current = activeAttemptId;
  }, [activeAttemptId]);

  useEffect(() => {
    if (!open) {
      return;
    }
    setBaseUrl("");
    setFallbackUsername("");
    setTargets([]);
    setSavingTargetId(null);
    setError(null);
    setStatus(null);
    setConnectionInfo(null);
    setActiveAttemptId(null);
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    return window.dolssh.warpgate.onImportEvent((event: WarpgateImportEvent) => {
      if (activeAttemptIdRef.current !== event.attemptId) {
        return;
      }

      if (event.status === "completed") {
        setActiveAttemptId(null);
        setStatus(event.status);
        setConnectionInfo(event.connectionInfo ?? null);
        setTargets(event.targets ?? []);
        setError(null);
        return;
      }

      if (event.status === "error") {
        setActiveAttemptId(null);
        setStatus(null);
        setTargets([]);
        setConnectionInfo(null);
        setError(event.errorMessage ?? "Warpgate target 목록을 불러오지 못했습니다.");
        return;
      }

      if (event.status === "cancelled") {
        setActiveAttemptId(null);
        setStatus(null);
        setTargets([]);
        setConnectionInfo(null);
        setError(event.errorMessage ?? "Warpgate 로그인이 취소되었습니다.");
        return;
      }

      setStatus(event.status);
      if (event.errorMessage != null) {
        setError(event.errorMessage);
      }
    });
  }, [open]);

  if (!open) {
    return null;
  }

  const resolvedUsername =
    connectionInfo?.username?.trim() || fallbackUsername.trim();

  const handleClose = async () => {
    const attemptId = activeAttemptIdRef.current;
    if (attemptId) {
      await window.dolssh.warpgate
        .cancelBrowserImport(attemptId)
        .catch(() => undefined);
      setActiveAttemptId(null);
    }
    onClose();
  };

  return (
    <DialogBackdrop
      onDismiss={() => {
        void handleClose();
      }}
      dismissDisabled={Boolean(savingTargetId)}
    >
      <div
        className="modal-card warpgate-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="warpgate-import-title"
      >
        <div className="modal-card__header">
          <div>
            <div className="section-kicker">Warpgate</div>
            <h3 id="warpgate-import-title">Import from Warpgate</h3>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={() => {
              void handleClose();
            }}
            aria-label="Close Warpgate import dialog"
          >
            ×
          </button>
        </div>

        <div className="modal-card__body">
          <div className="form-grid">
            <label className="form-field">
              <span>Warpgate URL</span>
              <input
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://warpgate.example.com"
              />
            </label>
          </div>

          {connectionInfo ? (
            <div className="form-note">
              SSH endpoint는 <code>{connectionInfo.sshHost}:{connectionInfo.sshPort}</code>
              로 감지되었습니다.
              {connectionInfo.username ? (
                <>
                  {" "}
                  현재 로그인 사용자는 <code>{connectionInfo.username}</code>입니다.
                </>
              ) : (
                <> 로그인 사용자명을 자동으로 확인하지 못해 직접 입력이 필요합니다.</>
              )}
            </div>
          ) : null}

          {connectionInfo && !connectionInfo.username ? (
            <label className="form-field">
              <span>Warpgate Username</span>
              <input
                value={fallbackUsername}
                onChange={(event) => {
                  setFallbackUsername(event.target.value);
                  if (error === "Warpgate 사용자명을 입력해 주세요.") {
                    setError(null);
                  }
                }}
                placeholder="example.user"
              />
            </label>
          ) : null}

          {getStatusMessage(status) ? (
            <div className="aws-import-dialog__loading">
              {getStatusMessage(status)}입니다.
            </div>
          ) : null}

          <div className="warpgate-import-dialog__actions">
            <button
              type="button"
              className="primary-button"
              disabled={
                !baseUrl.trim() ||
                !normalizeBaseUrl(baseUrl) ||
                Boolean(activeAttemptId) ||
                Boolean(savingTargetId)
              }
              onClick={async () => {
                setError(null);
                setTargets([]);
                setConnectionInfo(null);
                setFallbackUsername("");
                setStatus("opening-browser");
                try {
                  const { attemptId } =
                    await window.dolssh.warpgate.startBrowserImport(baseUrl);
                  activeAttemptIdRef.current = attemptId;
                  setActiveAttemptId(attemptId);
                } catch (startError) {
                  setActiveAttemptId(null);
                  setStatus(null);
                  setError(
                    startError instanceof Error
                      ? startError.message
                      : "Warpgate 로그인 창을 열지 못했습니다.",
                  );
                }
              }}
            >
              브라우저에서 로그인
            </button>
          </div>

          {error ? <div className="terminal-error-banner">{error}</div> : null}

          {targets.length === 0 && !status ? (
            <div className="empty-callout">
              <strong>
                Warpgate 주소를 입력한 뒤 브라우저에서 로그인해 SSH target 목록을
                불러와 주세요.
              </strong>
            </div>
          ) : null}

          {targets.length > 0 ? (
            <div className="operations-list">
              {targets.map((target) => {
                return (
                  <article key={target.id} className="operations-card">
                    <div className="operations-card__main">
                      <div className="operations-card__title-row">
                        <strong>{target.name}</strong>
                        <span className="status-pill">SSH</span>
                      </div>
                      <div className="operations-card__meta">
                        <span>{target.id}</span>
                        {connectionInfo ? (
                          <span>
                            {connectionInfo.sshHost}:{connectionInfo.sshPort}
                          </span>
                        ) : null}
                        {connectionInfo?.username ? (
                          <span>{connectionInfo.username}</span>
                        ) : null}
                      </div>
                    </div>
                    <div className="operations-card__actions">
                      <button
                        type="button"
                        className="primary-button"
                        disabled={!connectionInfo || savingTargetId === target.id}
                        onClick={async () => {
                          if (!connectionInfo || !resolvedUsername) {
                            setError("Warpgate 사용자명을 입력해 주세요.");
                            return;
                          }
                          setError(null);
                          setSavingTargetId(target.id);
                          try {
                            await onImport({
                              kind: "warpgate-ssh",
                              label: target.name,
                              groupName: currentGroupPath ?? "",
                              tags: [],
                              terminalThemeId: null,
                              warpgateBaseUrl: connectionInfo.baseUrl,
                              warpgateSshHost: connectionInfo.sshHost,
                              warpgateSshPort: connectionInfo.sshPort,
                              warpgateTargetId: target.id,
                              warpgateTargetName: target.name,
                              warpgateUsername: resolvedUsername,
                            });
                            onClose();
                          } catch (importError) {
                            setError(
                              importError instanceof Error
                                ? importError.message
                                : "Warpgate host를 저장하지 못했습니다.",
                            );
                          } finally {
                            setSavingTargetId(null);
                          }
                        }}
                      >
                        {savingTargetId === target.id ? "Adding..." : "Add host"}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : null}
        </div>
      </div>
    </DialogBackdrop>
  );
}
