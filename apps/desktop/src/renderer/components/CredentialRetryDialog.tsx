import { useEffect, useState } from "react";
import type { RdpCredentialFailure, SshCertificateInfo, VncCredentialFailure } from "@shared";
import type { CredentialRetryInput } from "../store/types";
import { vncFailureAsksAccount } from "../store/utils";
import { useHostFormController } from "../controllers/useHostFormController";
import { describeCertificateInfo } from "../lib/certificate-info";
import { loadSavedCredential } from "../services/desktop/settings";
import { DialogBackdrop } from "./DialogBackdrop";
import {
  Button,
  FieldGroup,
  Input,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalShell,
  SectionLabel,
} from "../ui";
import { useTranslation } from "react-i18next";

function normalizeRetryMessage(message: string): string {
  return message
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim();
}

function shouldHideRetryMessageForCertificate(
  message: string,
  hasCertificateSummary: boolean,
): boolean {
  if (!hasCertificateSummary) {
    return false;
  }

  const normalized = normalizeRetryMessage(message).toLowerCase();
  // 들어오는 오류 메시지를 판정하는 패턴이라 한국어 문구를 지우면 안 된다 — 예전
  // 메시지와 서버가 보내는 문구까지 잡아야 하므로 두 언어를 모두 유지한다.
  return normalized.includes("인증서") || normalized.includes("certificate");
}

export interface CredentialRetryDialogRequest {
  hostId: string;
  hostLabel: string;
  /** 머리말만 가른다 — SFTP 가 아니면 모두 SSH 접속이다(포트 포워딩·컨테이너·VNC 터널도). */
  source: "ssh" | "sftp" | "portForward" | "containers" | "containerShell" | "vnc" | "rdp";
  authType: "password" | "privateKey" | "certificate";
  message: string;
  initialUsername: string;
  hasStoredSecret: boolean;
  secretRef?: string | null;
  /** VNC 호스트 자신의 값을 묻는다 — 비밀번호만, 계정을 요구하는 서버면 계정도. */
  vncFailure?: VncCredentialFailure;
  /** RDP 호스트 자신의 값을 묻는다 — Windows 계정은 계정·비밀번호·도메인이 한 묶음이라 셋을 함께. */
  rdpFailure?: RdpCredentialFailure;
  /** RDP 도메인 칸에 미리 채울 값. */
  initialDomain?: string;
}

interface ImportedRetryFile {
  name: string;
  content: string;
}

interface CredentialRetryDialogProps {
  request: CredentialRetryDialogRequest | null;
  onClose: () => void;
  onSubmit: (input: CredentialRetryInput) => Promise<void>;
}

export function CredentialRetryDialog({
  request,
  onClose,
  onSubmit,
}: CredentialRetryDialogProps) {
  const { t: translate } = useTranslation();
  const { pickPrivateKey, pickSshCertificate } = useHostFormController();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [domain, setDomain] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [privateKeyFile, setPrivateKeyFile] =
    useState<ImportedRetryFile | null>(null);
  const [certificateFile, setCertificateFile] =
    useState<ImportedRetryFile | null>(null);
  const [certificateInfo, setCertificateInfo] =
    useState<SshCertificateInfo | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setUsername(request?.initialUsername ?? "");
    setPassword("");
    setDomain(request?.initialDomain ?? "");
    setPassphrase("");
    setPrivateKeyFile(null);
    setCertificateFile(null);
    setCertificateInfo(null);
    setSubmitting(false);
    setError(null);
  }, [request]);

  useEffect(() => {
    let cancelled = false;

    async function hydrateCertificateInfo() {
      if (
        !request ||
        request.authType !== "certificate" ||
        !request.secretRef
      ) {
        setCertificateInfo(null);
        return;
      }

      const loaded = await loadSavedCredential(request.secretRef).catch(
        () => null,
      );
      if (cancelled) {
        return;
      }
      setCertificateInfo(loaded?.certificateInfo ?? null);
    }

    void hydrateCertificateInfo();

    return () => {
      cancelled = true;
    };
  }, [request]);

  if (!request) {
    return null;
  }

  const requiresPrivateKey =
    request.authType === "privateKey" || request.authType === "certificate";
  const requiresCertificate = request.authType === "certificate";
  const certificateSummary =
    request.authType === "certificate"
      ? describeCertificateInfo(certificateInfo)
      : null;
  const visibleCertificateSummary =
    certificateSummary && certificateSummary.tone !== "neutral"
      ? certificateSummary
      : null;
  const normalizedMessage = normalizeRetryMessage(request.message);
  const displayMessage = shouldHideRetryMessageForCertificate(
    request.message,
    Boolean(visibleCertificateSummary),
  )
    ? null
    : normalizedMessage;
  // VNC 호스트 자신의 값이면 비밀번호만 묻는다 — 계정은 계정으로 로그인하는 서버(macOS 화면 공유)일 때만.
  const vncFailure = request.vncFailure;
  const showUsername = !vncFailure || vncFailureAsksAccount(vncFailure);
  const rdpFailure = request.rdpFailure;
  // RDP 는 계정을 미리 채웠으면(쓴 계정) 비밀번호 칸에서 시작한다 — 바꿀 것은 대개 비밀번호다.
  const focusPassword = !showUsername || (Boolean(rdpFailure) && Boolean(request.initialUsername.trim()));

  return (
    <DialogBackdrop dismissOnBackdrop={false}>
      <ModalShell
        role="dialog"
        aria-modal="true"
        aria-labelledby="credential-retry-title"
      >
        <ModalHeader>
          <div>
            <SectionLabel>
              {rdpFailure
                ? "RDP Retry"
                : vncFailure
                  ? "VNC Retry"
                  : request.source === "sftp"
                    ? "SFTP Retry"
                    : "SSH Retry"}
            </SectionLabel>
            <h3 id="credential-retry-title">
              {translate('credentialRetry.prompt', { label: request.hostLabel })}
            </h3>
          </div>
        </ModalHeader>
        <ModalBody className="grid gap-4">
          {displayMessage ? (
            <p className="text-[0.9rem] leading-[1.6] text-[var(--text-soft)]">
              {displayMessage}
            </p>
          ) : null}
          {visibleCertificateSummary ? (
            <div
              className={`rounded-[10px] border px-[0.9rem] py-[0.9rem] text-[0.9rem] leading-[1.6] ${
                visibleCertificateSummary.tone === "danger"
                  ? "border-[color-mix(in_srgb,var(--danger-text)_22%,var(--border))] bg-[var(--danger-bg)] text-[var(--danger-text)]"
                  : visibleCertificateSummary.tone === "warning"
                    ? "border-[color-mix(in_srgb,var(--accent)_22%,var(--border))] bg-[var(--selection-soft)] text-[var(--text-soft)]"
                    : "border-[var(--border-subtle)] bg-[var(--surface-secondary)] text-[var(--text-soft)]"
              }`}
            >
              <p className="font-semibold">{visibleCertificateSummary.title}</p>
              {visibleCertificateSummary.detail ? (
                <p>{visibleCertificateSummary.detail}</p>
              ) : null}
            </div>
          ) : null}
          {showUsername ? (
            <FieldGroup label="Username">
              <Input
                autoFocus={!focusPassword}
                value={username}
                onChange={(event) => {
                  setUsername(event.target.value);
                  setError(null);
                }}
                placeholder={rdpFailure ? "Administrator" : vncFailure ? "macOS account" : "ubuntu"}
              />
            </FieldGroup>
          ) : null}

          {request.authType === "password" ? (
            <FieldGroup label="Password">
              <Input
                autoFocus={focusPassword}
                type="password"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setError(null);
                }}
                placeholder="Enter password"
              />
            </FieldGroup>
          ) : null}

          {rdpFailure ? (
            <FieldGroup label="Domain">
              <Input
                value={domain}
                onChange={(event) => {
                  setDomain(event.target.value);
                  setError(null);
                }}
                placeholder={translate('hostForm.rdp.domainPlaceholder')}
              />
            </FieldGroup>
          ) : null}

          {requiresPrivateKey ? (
            <FieldGroup label="Private key file">
              <div className="flex gap-[0.7rem]">
                <Input
                  readOnly
                  value={privateKeyFile?.name ?? ""}
                  placeholder="Import private key"
                />
                <Button
                  variant="secondary"
                  onClick={async () => {
                    const selected = await pickPrivateKey();
                    if (!selected) {
                      return;
                    }
                    setPrivateKeyFile({
                      name: selected.name,
                      content: selected.content,
                    });
                    setError(null);
                  }}
                >
                  Import
                </Button>
              </div>
            </FieldGroup>
          ) : null}

          {requiresCertificate ? (
            <FieldGroup label="SSH certificate file">
              <div className="flex gap-[0.7rem]">
                <Input
                  readOnly
                  value={certificateFile?.name ?? ""}
                  placeholder="Import SSH certificate"
                />
                <Button
                  variant="secondary"
                  onClick={async () => {
                    const selected = await pickSshCertificate();
                    if (!selected) {
                      return;
                    }
                    setCertificateFile({
                      name: selected.name,
                      content: selected.content,
                    });
                    setCertificateInfo(null);
                    setError(null);
                  }}
                >
                  Import
                </Button>
              </div>
            </FieldGroup>
          ) : null}

          {requiresPrivateKey ? (
            <FieldGroup label="Passphrase">
              <Input
                type="password"
                value={passphrase}
                onChange={(event) => {
                  setPassphrase(event.target.value);
                  setError(null);
                }}
                placeholder="Enter passphrase"
              />
            </FieldGroup>
          ) : null}

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
              if (vncFailure) {
                // 계정을 요구하는 서버면 계정이 있어야 한다. 계정이 거절된 서버는 비워서 VNC 암호로 붙을 수 있다. 비밀번호는 늘
                // 새로 넣는다 — 저장된 것이 없거나 방금 거절됐다.
                if (vncFailure === "account-required" && !username.trim()) {
                  setError(translate('credentialRetry.usernameRequired'));
                  return;
                }
                if (!password) {
                  setError(translate('credentialRetry.passwordRequired'));
                  return;
                }
              } else if (!username.trim()) {
                setError(translate('credentialRetry.usernameRequired'));
                return;
              }
              // RDP 는 비밀번호를 늘 새로 넣는다 — 저장된 것이 없거나 방금 거절됐다.
              if (rdpFailure && !password) {
                setError(translate('credentialRetry.passwordRequired'));
                return;
              }
              if (
                !vncFailure &&
                !rdpFailure &&
                request.authType === "password" &&
                !request.hasStoredSecret &&
                !password
              ) {
                setError(translate('credentialRetry.passwordRequired'));
                return;
              }
              if (
                request.authType === "privateKey" &&
                !request.hasStoredSecret &&
                !privateKeyFile?.content
              ) {
                setError(translate('credentialRetry.keyRequired'));
                return;
              }
              if (
                request.authType === "certificate" &&
                !request.hasStoredSecret &&
                !privateKeyFile?.content
              ) {
                setError(translate('credentialRetry.keyImportRequired'));
                return;
              }
              if (
                request.authType === "certificate" &&
                !request.hasStoredSecret &&
                !certificateFile?.content
              ) {
                setError(translate('credentialRetry.certificateRequired'));
                return;
              }

              setSubmitting(true);
              try {
                await onSubmit({
                  username: username.trim(),
                  password: password || undefined,
                  ...(rdpFailure ? { domain: domain.trim() } : {}),
                  passphrase: passphrase || undefined,
                  privateKeyPem: privateKeyFile?.content,
                  certificateText: certificateFile?.content,
                });
              } catch (submitError) {
                setError(
                  submitError instanceof Error
                    ? submitError.message
                    : translate('credentialRetry.retryFailed'),
                );
                setSubmitting(false);
              }
            }}
          >
            {translate('credentialRetry.retry')}
          </Button>
        </ModalFooter>
      </ModalShell>
    </DialogBackdrop>
  );
}
