import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type {
  ActivityLogRecord,
  HostRecord,
  SavedWorkspaceRecord,
} from "@shared";
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
import { WorkspaceDetailPanel } from "./WorkspaceDetailPanel";
import { WorkspaceListPanel } from "./WorkspaceListPanel";

interface WorkspaceBrowserProps {
  sidebar: ReactNode;
  workspaces: readonly SavedWorkspaceRecord[];
  hosts: readonly HostRecord[];
  activityLogs: readonly ActivityLogRecord[];
  onOpen: (workspaceId: string) => void | Promise<unknown>;
  onRename: (workspaceId: string, name: string) => void | Promise<unknown>;
  onDuplicate: (workspaceId: string) => void | Promise<unknown>;
  onToggleFavorite: (
    workspaceId: string,
    favorite: boolean,
  ) => void | Promise<unknown>;
  onDelete: (workspaceId: string) => void | Promise<unknown>;
}

export function WorkspaceBrowser({
  sidebar,
  workspaces,
  hosts,
  activityLogs,
  onOpen,
  onRename,
  onDuplicate,
  onToggleFavorite,
  onDelete,
}: WorkspaceBrowserProps) {
  const { t } = useTranslation();
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
    null,
  );
  const [renameTarget, setRenameTarget] = useState<SavedWorkspaceRecord | null>(
    null,
  );
  const [renameName, setRenameName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<SavedWorkspaceRecord | null>(
    null,
  );
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);

  useEffect(() => {
    setSelectedWorkspaceId((current) => {
      if (current && workspaces.some((workspace) => workspace.id === current)) {
        return current;
      }
      return workspaces[0]?.id ?? null;
    });
  }, [workspaces]);

  const selectedWorkspace =
    workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ??
    null;

  const beginRename = (workspace: SavedWorkspaceRecord) => {
    setRenameTarget(workspace);
    setRenameName(workspace.name);
    setDialogError(null);
  };

  const beginDelete = (workspace: SavedWorkspaceRecord) => {
    setDeleteTarget(workspace);
    setDialogError(null);
  };

  const closeDialogs = () => {
    if (dialogBusy) {
      return;
    }
    setRenameTarget(null);
    setDeleteTarget(null);
    setDialogError(null);
  };

  const submitRename = async () => {
    if (!renameTarget || !renameName.trim()) {
      return;
    }
    setDialogBusy(true);
    setDialogError(null);
    try {
      await onRename(renameTarget.id, renameName.trim());
      setRenameTarget(null);
    } catch (error) {
      setDialogError(
        error instanceof Error
          ? error.message
          : t("savedWorkspace.renameFailed"),
      );
    } finally {
      setDialogBusy(false);
    }
  };

  const submitDelete = async () => {
    if (!deleteTarget) {
      return;
    }
    setDialogBusy(true);
    setDialogError(null);
    try {
      await onDelete(deleteTarget.id);
      setDeleteTarget(null);
    } catch (error) {
      setDialogError(
        error instanceof Error
          ? error.message
          : t("savedWorkspace.deleteFailed"),
      );
    } finally {
      setDialogBusy(false);
    }
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-[240px_minmax(0,1fr)_minmax(360px,400px)] max-[1320px]:grid-cols-[220px_minmax(0,1fr)_340px] max-[1040px]:grid-cols-1">
      {sidebar}
      <WorkspaceListPanel
        workspaces={workspaces}
        hosts={hosts}
        selectedWorkspaceId={selectedWorkspaceId}
        onSelect={setSelectedWorkspaceId}
        onOpen={onOpen}
        onRename={beginRename}
        onDuplicate={onDuplicate}
        onDelete={beginDelete}
      />
      <div className="h-full min-h-0 overflow-hidden border-l border-[var(--border)] max-[1040px]:hidden">
        <WorkspaceDetailPanel
          workspace={selectedWorkspace}
          hosts={hosts}
          activityLogs={activityLogs}
          onOpen={onOpen}
          onRename={beginRename}
          onDuplicate={onDuplicate}
          onToggleFavorite={onToggleFavorite}
          onDelete={beginDelete}
        />
      </div>

      {renameTarget
        ? createPortal(
            <DialogBackdrop onDismiss={closeDialogs}>
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
                  {dialogError ? (
                    <NoticeCard tone="danger" className="mt-3" role="alert">
                      {dialogError}
                    </NoticeCard>
                  ) : null}
                </ModalBody>
                <ModalFooter>
                  <Button
                    variant="secondary"
                    onClick={closeDialogs}
                    disabled={dialogBusy}
                  >
                    {t("common.cancel")}
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => void submitRename()}
                    disabled={dialogBusy || !renameName.trim()}
                  >
                    {t("common.save")}
                  </Button>
                </ModalFooter>
              </ModalShell>
            </DialogBackdrop>,
            document.body,
          )
        : null}

      {deleteTarget
        ? createPortal(
            <DialogBackdrop onDismiss={closeDialogs}>
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
                  {dialogError ? (
                    <NoticeCard tone="danger" role="alert">
                      {dialogError}
                    </NoticeCard>
                  ) : null}
                </ModalBody>
                <ModalFooter>
                  <Button
                    variant="secondary"
                    onClick={closeDialogs}
                    disabled={dialogBusy}
                  >
                    {t("common.cancel")}
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => void submitDelete()}
                    disabled={dialogBusy}
                  >
                    {t("common.delete")}
                  </Button>
                </ModalFooter>
              </ModalShell>
            </DialogBackdrop>,
            document.body,
          )
        : null}
    </div>
  );
}
