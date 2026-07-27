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
import { Trans, useTranslation } from "react-i18next";
import { t } from "../i18n";

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
    return t("warpgateImport.status.opening");
  }
  if (status === "waiting-for-login") {
    return t("warpgateImport.status.opened");
  }
  if (status === "loading-targets") {
    return t("warpgateImport.status.done");
  }
  if (status === "cancelled") {
    return t("warpgateImport.status.cancelled");
  }
  return null;
}

function getStatusDetail(
  status: WarpgateImportStatus | null,
  noticeMessage: string | null,
): string | null {
  if (status === "opening-browser") {
    return t("warpgateImport.detail.wait");
  }
  if (status === "waiting-for-login") {
    return t("warpgateImport.detail.completeOrCancel");
  }
  if (status === "loading-targets") {
    return t("warpgateImport.detail.loadingTargets");
  }
  if (status === "cancelled") {
    return (
      noticeMessage ??
      t("warpgateImport.detail.retryHint")
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
  const { t: translate } = useTranslation();
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
        setError(event.errorMessage ?? translate("warpgateImport.error.targetsFailed"));
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
          // 메인이 보내는 문구를 같은 카탈로그 키로 비교한다 — 원문 문자열을 substring
          // 으로 찾으면 UI 언어가 바뀌는 순간 감지가 깨진다.
          event.errorMessage === translate("warpgate.loginWindowClosed")
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
          : translate("warpgateImport.error.cancelFailed"),
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
            <p className="text-[0.9rem] leading-[1.6] text-[var(--text-soft)]">
              <Trans
                i18nKey="warpgateImport.endpointDetected"
                values={{
                  endpoint: `${connectionInfo.sshHost}:${connectionInfo.sshPort}`,
                }}
                components={{ code: <code /> }}
              />
              {connectionInfo.username ? (
                <>
                  {" "}
                  <Trans
                    i18nKey="warpgateImport.currentUser"
                    values={{ username: connectionInfo.username }}
                    components={{ code: <code /> }}
                  />
                </>
              ) : (
                <>{translate("warpgateImport.usernameUnknown")}</>
              )}
            </p>
          ) : null}

          {connectionInfo && !connectionInfo.username ? (
            <FieldGroup label="Warpgate Username">
              <Input
                value={fallbackUsername}
                onChange={(event) => {
                  setFallbackUsername(event.target.value);
                  if (error === translate("warpgateImport.error.usernameRequired")) {
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
                {translate(isCancelling ? "warpgateImport.cancelling" : "warpgateImport.cancel")}
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
                      : translate("warpgateImport.error.openFailed"),
                  );
                }
              }}
            >
              {translate("warpgateImport.signInBrowser")}
            </Button>
          </div>

          {error ? (
            <NoticeCard tone="danger" role="alert">
              {error}
            </NoticeCard>
          ) : null}

          {targets.length === 0 && !status ? (
            <NoticeCard
              title={translate("warpgateImport.emptyTitle")}
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
                            setError(translate("warpgateImport.error.usernameRequired"));
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
                                : translate("warpgateImport.error.saveFailed"),
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
            {translate('common.close')}
          </Button>
        </ModalFooter>
      </ModalShell>
    </DialogBackdrop>
  );
}
