import { useEffect, useRef, useState } from "react";
import type {
  HostDraft,
  WarpgateConnectionInfo,
  WarpgateImportEvent,
  WarpgateImportStatus,
  WarpgateTargetSummary,
} from "@shared";
import { useWarpgateImportController } from "../controllers/useImportControllers";
import { DialogBackdrop } from "./DialogBackdrop";
import {
  Button,
  Card,
  CardActions,
  CardMain,
  CardMeta,
  CardTitleRow,
  CloseIcon,
  FieldGroup,
  Input,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalShell,
  NoticeCard,
  IconButton,
  PanelSection,
  SectionLabel,
  StatusBadge,
} from "../ui";

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
    return "Warpgate 로그인 창을 여는 중입니다.";
  }
  if (status === "waiting-for-login") {
    return "Warpgate 로그인 창이 열려 있습니다.";
  }
  if (status === "loading-targets") {
    return "Warpgate 로그인은 완료되었습니다.";
  }
  if (status === "cancelled") {
    return "Warpgate 로그인을 중단했습니다.";
  }
  return null;
}

function getStatusDetail(
  status: WarpgateImportStatus | null,
  noticeMessage: string | null,
): string | null {
  if (status === "opening-browser") {
    return "잠시만 기다려 주세요.";
  }
  if (status === "waiting-for-login") {
    return "로그인을 완료하거나 아래에서 중단할 수 있습니다.";
  }
  if (status === "loading-targets") {
    return "SSH target 목록을 불러오는 중입니다.";
  }
  if (status === "cancelled") {
    return (
      noticeMessage ??
      "주소를 확인한 뒤 다시 시도할 수 있습니다."
    );
  }
  return null;
}

export function WarpgateImportDialog({
  open,
  currentGroupPath,
  onClose,
  onImport,
}: WarpgateImportDialogProps) {
  const {
    cancelWarpgateBrowserImport,
    onWarpgateImportEvent,
    startWarpgateBrowserImport,
  } = useWarpgateImportController();
  const [baseUrl, setBaseUrl] = useState("");
  const [fallbackUsername, setFallbackUsername] = useState("");
  const [targets, setTargets] = useState<WarpgateTargetSummary[]>([]);
  const [savingTargetId, setSavingTargetId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noticeMessage, setNoticeMessage] = useState<string | null>(null);
  const [status, setStatus] = useState<WarpgateImportStatus | null>(null);
  const [connectionInfo, setConnectionInfo] =
    useState<WarpgateConnectionInfo | null>(null);
  const [activeAttemptId, setActiveAttemptId] = useState<string | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);
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
    setNoticeMessage(null);
    setStatus(null);
    setConnectionInfo(null);
    setActiveAttemptId(null);
    setIsCancelling(false);
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    return onWarpgateImportEvent((event: WarpgateImportEvent) => {
      if (activeAttemptIdRef.current !== event.attemptId) {
        return;
      }

      if (event.status === "completed") {
        setActiveAttemptId(null);
        setIsCancelling(false);
        setStatus(event.status);
        setConnectionInfo(event.connectionInfo ?? null);
        setTargets(event.targets ?? []);
        setError(null);
        setNoticeMessage(null);
        return;
      }

      if (event.status === "error") {
        setActiveAttemptId(null);
        setIsCancelling(false);
        setStatus(null);
        setTargets([]);
        setConnectionInfo(null);
        setNoticeMessage(null);
        setError(event.errorMessage ?? "Warpgate target 목록을 불러오지 못했습니다.");
        return;
      }

      if (event.status === "cancelled") {
        setActiveAttemptId(null);
        setIsCancelling(false);
        setStatus(event.status);
        setTargets([]);
        setConnectionInfo(null);
        setError(null);
        setNoticeMessage(
          event.errorMessage?.includes("창이 닫혔습니다.")
            ? event.errorMessage
            : null,
        );
        return;
      }

      setStatus(event.status);
      setNoticeMessage(null);
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
  const statusMessage = getStatusMessage(status);
  const statusDetail = getStatusDetail(status, noticeMessage);

  const handleClose = async () => {
    const attemptId = activeAttemptIdRef.current;
    if (attemptId) {
      await cancelWarpgateBrowserImport(attemptId)
        .catch(() => undefined);
      setActiveAttemptId(null);
    }
    onClose();
  };

  const handleCancelAttempt = async () => {
    const attemptId = activeAttemptIdRef.current;
    if (!attemptId || isCancelling || savingTargetId) {
      return;
    }

    setIsCancelling(true);
    try {
      await cancelWarpgateBrowserImport(attemptId);
      setActiveAttemptId(null);
      setStatus("cancelled");
      setTargets([]);
      setConnectionInfo(null);
      setError(null);
      setNoticeMessage(null);
    } catch (cancelError) {
      setError(
        cancelError instanceof Error
          ? cancelError.message
          : "Warpgate 로그인을 중단하지 못했습니다.",
      );
    } finally {
      setIsCancelling(false);
    }
  };

  return (
    <DialogBackdrop
      onDismiss={() => {
        void handleClose();
      }}
      dismissDisabled={Boolean(savingTargetId)}
    >
      <ModalShell
        role="dialog"
        aria-modal="true"
        aria-labelledby="warpgate-import-title"
        size="lg"
      >
        <ModalHeader>
          <div>
            <SectionLabel>Warpgate</SectionLabel>
            <h3 id="warpgate-import-title">Import from Warpgate</h3>
          </div>
          <IconButton
            onClick={() => {
              void handleClose();
            }}
            aria-label="Close Warpgate import dialog"
          >
            <CloseIcon />
          </IconButton>
        </ModalHeader>

        <ModalBody className="grid gap-4">
          <FieldGroup label="Warpgate URL">
            <Input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://warpgate.example.com"
            />
          </FieldGroup>

          {connectionInfo ? (
            <p className="text-[0.92rem] leading-[1.6] text-[var(--text-soft)]">
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
            </p>
          ) : null}

          {connectionInfo && !connectionInfo.username ? (
            <FieldGroup label="Warpgate Username">
              <Input
                value={fallbackUsername}
                onChange={(event) => {
                  setFallbackUsername(event.target.value);
                  if (error === "Warpgate 사용자명을 입력해 주세요.") {
                    setError(null);
                  }
                }}
                placeholder="example.user"
              />
            </FieldGroup>
          ) : null}

          {statusMessage ? (
            <NoticeCard title={statusMessage}>
              {statusDetail ? <p>{statusDetail}</p> : null}
            </NoticeCard>
          ) : null}

          <div className="flex flex-wrap items-center justify-end gap-3">
            {activeAttemptId ? (
              <Button
                variant="danger"
                disabled={Boolean(savingTargetId) || isCancelling}
                onClick={() => {
                  void handleCancelAttempt();
                }}
              >
                {isCancelling ? "중단 중..." : "중단"}
              </Button>
            ) : null}
            <Button
              variant="primary"
              disabled={
                !baseUrl.trim() ||
                !normalizeBaseUrl(baseUrl) ||
                Boolean(activeAttemptId) ||
                Boolean(savingTargetId)
              }
              onClick={async () => {
                setError(null);
                setNoticeMessage(null);
                setTargets([]);
                setConnectionInfo(null);
                setFallbackUsername("");
                setStatus("opening-browser");
                try {
                  const { attemptId } =
                    await startWarpgateBrowserImport(baseUrl);
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
            </Button>
          </div>

          {error ? (
            <NoticeCard tone="danger" role="alert">
              {error}
            </NoticeCard>
          ) : null}

          {targets.length === 0 && !status ? (
            <NoticeCard
              title="Warpgate 주소를 입력한 뒤 브라우저에서 로그인해 SSH target 목록을 불러와 주세요."
            />
          ) : null}

          {targets.length > 0 ? (
            <PanelSection>
              {targets.map((target) => {
                return (
                  <Card key={target.id}>
                    <CardMain>
                      <CardTitleRow>
                        <strong>{target.name}</strong>
                        <StatusBadge>SSH</StatusBadge>
                      </CardTitleRow>
                      <CardMeta>
                        <span>{target.id}</span>
                        {connectionInfo ? (
                          <span>
                            {connectionInfo.sshHost}:{connectionInfo.sshPort}
                          </span>
                        ) : null}
                        {connectionInfo?.username ? (
                          <span>{connectionInfo.username}</span>
                        ) : null}
                      </CardMeta>
                    </CardMain>
                    <CardActions>
                      <Button
                        variant="primary"
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
                      </Button>
                    </CardActions>
                  </Card>
                );
              })}
            </PanelSection>
          ) : null}
        </ModalBody>
        <ModalFooter className="justify-start">
          <Button variant="secondary" onClick={() => void handleClose()} disabled={Boolean(savingTargetId)}>
            닫기
          </Button>
        </ModalFooter>
      </ModalShell>
    </DialogBackdrop>
  );
}
