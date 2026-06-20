import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import type { DesktopApi } from "@shared";
import { desktopApi } from "./desktopApi";

export interface EditorSession {
  endpointId: string;
  remotePath: string;
  fileName: string;
  content: string;
  originalContent: string;
  mode: number;
  size: number;
  mtime: string;
  isDirty: boolean;
}

interface EditorTarget {
  endpointId: string;
  remotePath: string;
  fileName: string;
}

export interface EditorState {
  target: EditorTarget | null;
  session: EditorSession | null;
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;
  conflict: boolean;
  sudoRequired: boolean;
  openEditor: (target: EditorTarget) => Promise<void>;
  setEditorContent: (content: string) => void;
  saveEditor: (options?: {
    force?: boolean;
    sudoPassword?: string;
  }) => Promise<boolean>;
  reloadEditor: () => Promise<void>;
  revertEditor: () => void;
  closeEditor: () => void;
  clearEditorError: () => void;
  dismissSudoPrompt: () => void;
}

// Binary / oversized rejections from the core are treated as "silently not
// editable" — the editor simply never opens, matching the product decision.
const SILENT_OPEN_ERROR = /binary|too large/i;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function createEditorStore(api: DesktopApi) {
  return createStore<EditorState>((set, get) => ({
    target: null,
    session: null,
    isLoading: false,
    isSaving: false,
    error: null,
    conflict: false,
    sudoRequired: false,

    openEditor: async (target) => {
      set({
        target,
        session: null,
        isLoading: true,
        error: null,
        conflict: false,
        sudoRequired: false,
      });
      try {
        const read = await api.sftp.readFile({
          endpointId: target.endpointId,
          path: target.remotePath,
        });
        // Drop the result if the user already closed or switched files.
        if (get().target?.remotePath !== target.remotePath) {
          return;
        }
        set({
          isLoading: false,
          session: {
            endpointId: target.endpointId,
            remotePath: target.remotePath,
            fileName: target.fileName,
            content: read.content,
            originalContent: read.content,
            mode: read.mode,
            size: read.size,
            mtime: read.mtime,
            isDirty: false,
          },
        });
      } catch (error) {
        if (get().target?.remotePath !== target.remotePath) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (SILENT_OPEN_ERROR.test(message)) {
          set({ target: null, isLoading: false });
          return;
        }
        set({ isLoading: false, error: message });
      }
    },

    setEditorContent: (content) => {
      const session = get().session;
      if (!session) {
        return;
      }
      set({
        session: {
          ...session,
          content,
          isDirty: content !== session.originalContent,
        },
      });
    },

    saveEditor: async (options = {}) => {
      const session = get().session;
      if (!session) {
        return false;
      }
      set({ isSaving: true, error: null });
      try {
        await api.sftp.writeFile({
          endpointId: session.endpointId,
          path: session.remotePath,
          content: session.content,
          mode: session.mode,
          preserveMtime: false,
          expectedSize: session.size,
          expectedMtime: session.mtime,
          force: options.force,
          sudoPassword: options.sudoPassword,
        });

        // Refresh the conflict snapshot (size + mtime) for subsequent saves,
        // without disturbing the editor buffer / cursor.
        let nextSize = byteLength(session.content);
        let nextMtime = session.mtime;
        try {
          const fresh = await api.sftp.readFile({
            endpointId: session.endpointId,
            path: session.remotePath,
          });
          nextSize = fresh.size;
          nextMtime = fresh.mtime;
        } catch {
          // Best-effort refresh; keep the computed size and previous mtime.
        }

        const current = get().session;
        if (!current || current.remotePath !== session.remotePath) {
          set({ isSaving: false, conflict: false, sudoRequired: false });
          return true;
        }
        set({
          isSaving: false,
          conflict: false,
          sudoRequired: false,
          session: {
            ...current,
            originalContent: session.content,
            isDirty: current.content !== session.content,
            size: nextSize,
            mtime: nextMtime,
          },
        });
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("sftp-conflict:")) {
          set({ isSaving: false, conflict: true });
          return false;
        }
        if (message.includes("sftp-sudo-required:")) {
          set({ isSaving: false, sudoRequired: true });
          return false;
        }
        set({ isSaving: false, error: message });
        return false;
      }
    },

    reloadEditor: async () => {
      const target = get().target;
      if (!target) {
        return;
      }
      await get().openEditor(target);
    },

    revertEditor: () => {
      const session = get().session;
      if (!session) {
        return;
      }
      set({
        session: {
          ...session,
          content: session.originalContent,
          isDirty: false,
        },
        conflict: false,
      });
    },

    closeEditor: () => {
      set({
        target: null,
        session: null,
        isLoading: false,
        isSaving: false,
        error: null,
        conflict: false,
        sudoRequired: false,
      });
    },

    clearEditorError: () => set({ error: null }),
    dismissSudoPrompt: () => set({ sudoRequired: false }),
  }));
}

export const editorStore = createEditorStore(desktopApi);

export function useEditorStore<T>(selector: (state: EditorState) => T): T {
  return useStore(editorStore, selector);
}
