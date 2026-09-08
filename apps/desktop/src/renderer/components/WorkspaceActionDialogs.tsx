import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { SavedWorkspaceRecord } from "@shared";
import { useTranslation } from "react-i18next";
import {
  Button,
  Input,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalShell,
  NoticeCard,
  SectionLabel,
} from "../ui";
import { DialogBackdrop } from "./DialogBackdrop";

interface WorkspaceActionDialogsProps {
  renameTarget: SavedWorkspaceRecord | null;
  deleteTarget: SavedWorkspaceRecord | null;
  onClose: () => void;
  onRename: (workspaceId: string, name: string) => void | Promise<unknown>;
  onDelete: (workspaceId: string) => void | Promise<unknown>;
}

export function WorkspaceActionDialogs({
  renameTarget,
  deleteTarget,
  onClose,
  onRename,
  onDelete,
}: WorkspaceActionDialogsProps) {
  const { t } = useTranslation();
  const [renameName, setRenameName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setRenameName(renameTarget?.name ?? "");
    setError(null);
  }, [renameTarget]);

  useEffect(() => {
    setError(null);
  }, [deleteTarget]);

  const close = () => {
    if (!busy) {
      onClose();
      setError(null);
    }
  };

  const submitRename = async () => {
    if (!renameTarget || !renameName.trim()) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onRename(renameTarget.id, renameName.trim());
      onClose();
    } catch (renameError) {
      setError(
        renameError instanceof Error
          ? renameError.message
          : t("savedWorkspace.renameFailed"),
      );
    } finally {
      setBusy(false);
    }
  };

  const submitDelete = async () => {
    if (!deleteTarget) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onDelete(deleteTarget.id);
      onClose();
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : t("savedWorkspace.deleteFailed"),
      );
    } finally {
      setBusy(false);
    }
  };

  if (renameTarget) {
    return createPortal(
      <DialogBackdrop onDismiss={close} dismissDisabled={busy}>
        <ModalShell
          size="sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="saved-workspace-rename-title"
          onClick={(event) => event.stopPropagation()}
        >
          <ModalHeader className="block">
            <SectionLabel>{t("savedWorkspace.section")}</SectionLabel>
            <h3
              id="saved-workspace-rename-title"
              className="mt-1 text-lg font-bold"
            >
              {t("savedWorkspace.renameTitle")}
            </h3>
            <p className="mt-1 text-sm text-[var(--text-soft)]">
              {t("savedWorkspace.renameDescription")}
            </p>
          </ModalHeader>
          <ModalBody>
            <label className="grid gap-2 text-[0.78rem] font-semibold text-[var(--text-soft)]">
              {t("savedWorkspace.nameLabel")}
              <Input
                autoFocus
                value={renameName}
                maxLength={80}
                onChange={(event) => setRenameName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void submitRename();
                  }
                }}
              />
            </label>
            {error ? (
              <NoticeCard tone="danger" className="mt-3" role="alert">
                {error}
              </NoticeCard>
            ) : null}
          </ModalBody>
          <ModalFooter>
            <Button variant="secondary" onClick={close} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              onClick={() => void submitRename()}
              disabled={busy || !renameName.trim()}
            >
              {t("common.save")}
            </Button>
          </ModalFooter>
        </ModalShell>
      </DialogBackdrop>,
      document.body,
    );
  }

  if (deleteTarget) {
    return createPortal(
      <DialogBackdrop onDismiss={close} dismissDisabled={busy}>
        <ModalShell
          size="sm"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="saved-workspace-delete-title"
          onClick={(event) => event.stopPropagation()}
        >
          <ModalHeader className="block">
            <SectionLabel>{t("savedWorkspace.section")}</SectionLabel>
            <h3
              id="saved-workspace-delete-title"
              className="mt-1 text-lg font-bold"
            >
              {t("savedWorkspace.deleteTitle")}
            </h3>
          </ModalHeader>
          <ModalBody>
            <p className="text-sm leading-6 text-[var(--text-soft)]">
              {t("savedWorkspace.deleteDescription", {
                name: deleteTarget.name,
              })}
            </p>
            {error ? (
              <NoticeCard tone="danger" role="alert">
                {error}
              </NoticeCard>
            ) : null}
          </ModalBody>
          <ModalFooter>
            <Button variant="secondary" onClick={close} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              onClick={() => void submitDelete()}
              disabled={busy}
            >
              {t("common.delete")}
            </Button>
          </ModalFooter>
        </ModalShell>
      </DialogBackdrop>,
      document.body,
    );
  }

  return null;
}
