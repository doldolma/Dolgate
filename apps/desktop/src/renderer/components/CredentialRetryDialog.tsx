import { useEffect, useState } from "react";
import type { SshCertificateInfo } from "@shared";
import type { CredentialRetryInput } from "../store/types";
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
  source: "ssh" | "sftp";
  authType: "password" | "privateKey" | "certificate";
  message: string;
  initialUsername: string;
  hasStoredSecret: boolean;
  secretRef?: string | null;
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
              {request.source === "sftp" ? "SFTP Retry" : "SSH Retry"}
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
          <FieldGroup label="Username">
            <Input
              autoFocus
              value={username}
              onChange={(event) => {
                setUsername(event.target.value);
                setError(null);
              }}
              placeholder="ubuntu"
            />
          </FieldGroup>

          {request.authType === "password" ? (
            <FieldGroup label="Password">
              <Input
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
              if (!username.trim()) {
                setError(translate('credentialRetry.usernameRequired'));
                return;
              }
              if (
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
