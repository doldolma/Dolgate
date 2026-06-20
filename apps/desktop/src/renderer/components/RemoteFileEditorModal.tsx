import { lazy, Suspense, useEffect, useState } from "react";
import type { KeyboardEvent } from "react";
import { useEditorStore } from "../store/editorStore";
import { useAppStore } from "../store/appStore";
import { formatFileSize } from "../lib/file-size";
import { DialogBackdrop } from "./DialogBackdrop";
import {
  Button,
  CloseIcon,
  IconButton,
  Input,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalShell,
  SectionLabel,
} from "../ui";

// Code-split: CodeMirror (and its dependencies) load only when a file opens.
const CodeMirrorEditor = lazy(() => import("./CodeMirrorEditor"));

export function RemoteFileEditorModal() {
  const target = useEditorStore((state) => state.target);
  const session = useEditorStore((state) => state.session);
  const isLoading = useEditorStore((state) => state.isLoading);
  const isSaving = useEditorStore((state) => state.isSaving);
  const error = useEditorStore((state) => state.error);
  const conflict = useEditorStore((state) => state.conflict);
  const sudoRequired = useEditorStore((state) => state.sudoRequired);
  const setEditorContent = useEditorStore((state) => state.setEditorContent);
  const saveEditor = useEditorStore((state) => state.saveEditor);
  const reloadEditor = useEditorStore((state) => state.reloadEditor);
  const revertEditor = useEditorStore((state) => state.revertEditor);
  const closeEditor = useEditorStore((state) => state.closeEditor);
  const dismissSudoPrompt = useEditorStore((state) => state.dismissSudoPrompt);

  const fontFamily = useAppStore((state) => state.settings.terminalFontFamily);
  const fontSize = useAppStore((state) => state.settings.terminalFontSize);

  const [sudoPassword, setSudoPassword] = useState("");

  useEffect(() => {
    if (!sudoRequired) {
      setSudoPassword("");
    }
  }, [sudoRequired]);

  if (!target) {
    return null;
  }

  const fileName = session?.fileName ?? target.fileName;
  const isDirty = session?.isDirty ?? false;

  function requestClose() {
    if (
      isDirty &&
      !window.confirm("저장하지 않은 변경사항이 있습니다. 편집기를 닫을까요?")
    ) {
      return;
    }
    closeEditor();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (session && isDirty && !isSaving && !sudoRequired) {
        void saveEditor();
      }
    }
  }

  return (
    <DialogBackdrop onDismiss={requestClose} dismissDisabled={isSaving}>
      <ModalShell
        role="dialog"
        aria-modal="true"
        aria-label={`Edit ${fileName}`}
        size="xl"
        onKeyDown={handleKeyDown}
      >
        <ModalHeader>
          <div className="min-w-0">
            <SectionLabel>원격 파일 편집</SectionLabel>
            <h3 className="truncate" title={session?.remotePath ?? fileName}>
              {fileName}
              {isDirty ? (
                <span className="ml-2 text-[var(--accent-strong)]" aria-hidden>
                  ●
                </span>
              ) : null}
            </h3>
          </div>
          <IconButton
            type="button"
            onClick={requestClose}
            aria-label="Close editor"
          >
            <CloseIcon />
          </IconButton>
        </ModalHeader>

        <ModalBody>
          {isLoading ? (
            <p className="text-[var(--text-soft)]">파일을 불러오는 중입니다…</p>
          ) : null}

          {!isLoading && !session && error ? (
            <p className="text-[0.9rem] text-[var(--danger-text)]">{error}</p>
          ) : null}

          {session ? (
            <div className="flex flex-col gap-3">
              {conflict ? (
                <div className="rounded-[14px] border border-[color-mix(in_srgb,var(--accent)_30%,var(--border))] bg-[var(--selection-soft)] px-4 py-3 text-[0.92rem] leading-[1.5] text-[var(--text)]">
                  <p className="font-semibold">
                    편집하는 동안 원격 파일이 변경되었습니다.
                  </p>
                  <p className="text-[var(--text-soft)]">
                    다시 불러와 변경 내용을 확인하거나, 현재 내용으로 덮어쓸 수
                    있습니다.
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      onClick={() => void reloadEditor()}
                      disabled={isSaving}
                    >
                      다시 불러오기
                    </Button>
                    <Button
                      variant="primary"
                      onClick={() => void saveEditor({ force: true })}
                      disabled={isSaving}
                    >
                      덮어쓰기
                    </Button>
                  </div>
                </div>
              ) : null}

              {sudoRequired ? (
                <div className="rounded-[14px] border border-[color-mix(in_srgb,var(--accent)_30%,var(--border))] bg-[var(--surface-secondary)] px-4 py-3">
                  <p className="text-[0.92rem] font-semibold text-[var(--text)]">
                    이 파일을 저장하려면 sudo 권한이 필요합니다.
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Input
                      type="password"
                      value={sudoPassword}
                      onChange={(event) => setSudoPassword(event.target.value)}
                      placeholder="sudo 비밀번호"
                      autoFocus
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && sudoPassword) {
                          void saveEditor({ sudoPassword });
                        }
                      }}
                    />
                    <Button
                      variant="primary"
                      onClick={() => void saveEditor({ sudoPassword })}
                      disabled={isSaving || !sudoPassword}
                    >
                      sudo로 저장
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={dismissSudoPrompt}
                      disabled={isSaving}
                    >
                      취소
                    </Button>
                  </div>
                </div>
              ) : null}

              {error && !conflict && !sudoRequired ? (
                <p className="text-[0.9rem] text-[var(--danger-text)]">{error}</p>
              ) : null}

              <div className="overflow-hidden rounded-[14px] border border-[var(--border)]">
                <Suspense
                  fallback={
                    <div className="p-4 text-[var(--text-soft)]">
                      편집기를 불러오는 중…
                    </div>
                  }
                >
                  <CodeMirrorEditor
                    value={session.content}
                    fileName={session.fileName}
                    fontFamily={fontFamily}
                    fontSize={fontSize}
                    onChange={setEditorContent}
                  />
                </Suspense>
              </div>
            </div>
          ) : null}
        </ModalBody>

        <ModalFooter>
          <span className="mr-auto text-[0.82rem] text-[var(--text-soft)]">
            {session ? formatFileSize(session.size) : ""}
          </span>
          <Button
            variant="secondary"
            onClick={revertEditor}
            disabled={!isDirty || isSaving}
          >
            되돌리기
          </Button>
          <Button variant="secondary" onClick={requestClose} disabled={isSaving}>
            닫기
          </Button>
          <Button
            variant="primary"
            onClick={() => void saveEditor()}
            disabled={!session || !isDirty || isSaving || sudoRequired}
          >
            {isSaving ? "저장 중…" : "저장"}
          </Button>
        </ModalFooter>
      </ModalShell>
    </DialogBackdrop>
  );
}
