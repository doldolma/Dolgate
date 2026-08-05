import { Buffer } from "buffer";
import { act } from "react-test-renderer";
import {
  registerSftpRuntimeForTests,
  resetMobileStoreRuntimeForTests,
  useMobileAppStore,
} from "../src/store/useMobileAppStore";

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => null),
  removeItem: jest.fn(async () => null),
  clear: jest.fn(async () => null),
}));
jest.mock("react-native-keychain", () => ({
  ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: "WHEN_UNLOCKED_THIS_DEVICE_ONLY" },
  getGenericPassword: jest.fn(async () => null),
  setGenericPassword: jest.fn(async () => true),
  resetGenericPassword: jest.fn(async () => true),
}));

const SFTP_ID = "sftp-1";

function installRuntime(overrides: Record<string, unknown> = {}) {
  const readTextFile = jest.fn(async () => ({
    content: "a=1\n",
    size: 4,
    mtime: "2026-08-04T00:00:00Z",
    mode: 0o644,
  }));
  const writeTextFile = jest.fn(async () => undefined);
  const connection = {
    listDirectory: jest.fn(async () => ({ path: "/etc", entries: [] })),
    readFileChunk: jest.fn(),
    writeFileChunk: jest.fn(),
    mkdir: jest.fn(),
    rename: jest.fn(),
    chmod: jest.fn(),
    delete: jest.fn(),
    close: jest.fn(),
    readTextFile,
    writeTextFile,
    ...overrides,
  };
  registerSftpRuntimeForTests(SFTP_ID, "host-1", connection as never);
  return { connection, readTextFile, writeTextFile };
}

describe("SFTP 내장 편집기", () => {
  beforeEach(() => {
    resetMobileStoreRuntimeForTests();
    useMobileAppStore.setState({ sftpEditor: null });
  });

  it("파일을 열면 원본을 기준으로 삼는다", async () => {
    const { readTextFile } = installRuntime();

    await act(async () => {
      await useMobileAppStore.getState().openSftpEditor(SFTP_ID, "/etc/app.conf");
    });

    expect(readTextFile).toHaveBeenCalledWith("/etc/app.conf");
    const editor = useMobileAppStore.getState().sftpEditor;
    expect(editor?.fileName).toBe("app.conf");
    expect(editor?.content).toBe("a=1\n");
    expect(editor?.originalContent).toBe("a=1\n");
    expect(editor?.isLoading).toBe(false);
  });

  // 저장은 열었을 때의 size·mtime 을 함께 보낸다 — 그게 없으면 엔진이 충돌을 판정할 수 없다.
  it("저장할 때 열었을 때의 기준을 함께 보내고, 저장 뒤 기준을 갱신한다", async () => {
    const { readTextFile, writeTextFile } = installRuntime();
    await act(async () => {
      await useMobileAppStore.getState().openSftpEditor(SFTP_ID, "/etc/app.conf");
    });

    act(() => {
      useMobileAppStore.getState().setSftpEditorContent("a=2\n");
    });

    readTextFile.mockResolvedValueOnce({
      content: "a=2\n",
      size: 4,
      mtime: "2026-08-04T01:00:00Z",
      mode: 0o644,
    });
    let saved = false;
    await act(async () => {
      saved = await useMobileAppStore.getState().saveSftpEditor();
    });

    expect(saved).toBe(true);
    expect(writeTextFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/etc/app.conf",
        content: "a=2\n",
        expectedSize: 4,
        expectedMtime: "2026-08-04T00:00:00Z",
        force: false,
      }),
    );
    // 저장한 내용이 새 기준이 돼야 이어지는 저장이 우리 변경을 충돌로 읽지 않는다.
    const editor = useMobileAppStore.getState().sftpEditor;
    expect(editor?.originalContent).toBe("a=2\n");
    expect(editor?.mtime).toBe("2026-08-04T01:00:00Z");
  });

  // 저장 뒤 다시 읽기가 실패하면 기준을 직접 계산해야 한다. 원격은 바이트로 재므로 JS 문자열
  // length(UTF-16 단위)를 쓰면 한글이 든 파일에서 어긋나 다음 저장이 거짓 충돌을 낸다.
  it("저장 뒤 다시 읽기가 실패하면 바이트 길이와 이전 mtime 을 기준으로 남긴다", async () => {
    const { readTextFile } = installRuntime();
    readTextFile.mockResolvedValueOnce({
      content: "설정=1\n",
      size: Buffer.byteLength("설정=1\n", "utf8"),
      mtime: "2026-08-04T00:00:00Z",
      mode: 0o644,
    });
    await act(async () => {
      await useMobileAppStore.getState().openSftpEditor(SFTP_ID, "/etc/app.conf");
    });

    const edited = "설정=2\n주석\n";
    act(() => {
      useMobileAppStore.getState().setSftpEditorContent(edited);
    });

    readTextFile.mockRejectedValueOnce(new Error("connection dropped"));
    await act(async () => {
      await useMobileAppStore.getState().saveSftpEditor();
    });

    const editor = useMobileAppStore.getState().sftpEditor;
    expect(editor?.size).toBe(Buffer.byteLength(edited, "utf8"));
    expect(editor?.size).not.toBe(edited.length);
    // 이전 mtime 을 남겨 다음 저장이 충돌로 걸리게 한다 — 조용히 덮어쓰지 않는다.
    expect(editor?.mtime).toBe("2026-08-04T00:00:00Z");
  });

  it("원격이 바뀌면 조용히 덮어쓰지 않고 충돌로 표시한다", async () => {
    const { writeTextFile } = installRuntime();
    await act(async () => {
      await useMobileAppStore.getState().openSftpEditor(SFTP_ID, "/etc/app.conf");
    });
    act(() => {
      useMobileAppStore.getState().setSftpEditorContent("mine\n");
    });

    writeTextFile.mockRejectedValueOnce(
      new Error("sftp-conflict: remote file changed since it was opened"),
    );
    let saved = true;
    await act(async () => {
      saved = await useMobileAppStore.getState().saveSftpEditor();
    });

    expect(saved).toBe(false);
    const editor = useMobileAppStore.getState().sftpEditor;
    expect(editor?.conflict).toBe(true);
    expect(editor?.isSaving).toBe(false);
    // 편집 내용은 남아 있어야 한다 — 사용자가 덮어쓰기를 고를 수 있어야 하니까.
    expect(editor?.content).toBe("mine\n");
  });

  // 저장은 await 를 지난다. 그 사이 다른 파일을 열었으면 방금 저장한 결과를 그 파일에
  // 덮어써선 안 된다 — 그러면 남의 파일이 수정되지 않은 것처럼 보인다.
  it("저장이 끝나는 동안 다른 파일을 열었으면 그 파일의 기준을 건드리지 않는다", async () => {
    const { readTextFile, writeTextFile } = installRuntime();
    await act(async () => {
      await useMobileAppStore.getState().openSftpEditor(SFTP_ID, "/etc/first.conf");
    });
    act(() => {
      useMobileAppStore.getState().setSftpEditorContent("first edited\n");
    });

    // 저장이 진행되는 사이 사용자가 다른 파일을 연 상황을 만든다.
    let releaseWrite: (() => void) | null = null;
    writeTextFile.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          releaseWrite = () => resolve(undefined);
        }),
    );
    let savePromise: Promise<boolean> | null = null;
    act(() => {
      savePromise = useMobileAppStore.getState().saveSftpEditor();
    });

    readTextFile.mockResolvedValueOnce({
      content: "second\n",
      size: 7,
      mtime: "2026-08-04T09:00:00Z",
      mode: 0o644,
    });
    await act(async () => {
      await useMobileAppStore.getState().openSftpEditor(SFTP_ID, "/etc/second.conf");
    });

    await act(async () => {
      releaseWrite?.();
      await savePromise;
    });

    const editor = useMobileAppStore.getState().sftpEditor;
    expect(editor?.path).toBe("/etc/second.conf");
    expect(editor?.content).toBe("second\n");
    // 첫 파일의 저장 결과가 여기에 스며들지 않아야 한다.
    expect(editor?.originalContent).toBe("second\n");
    expect(editor?.mtime).toBe("2026-08-04T09:00:00Z");
  });

  it("덮어쓰기를 고르면 기준을 보내지 않고 force 로 저장한다", async () => {
    const { writeTextFile } = installRuntime();
    await act(async () => {
      await useMobileAppStore.getState().openSftpEditor(SFTP_ID, "/etc/app.conf");
    });
    act(() => {
      useMobileAppStore.getState().setSftpEditorContent("mine\n");
    });

    await act(async () => {
      await useMobileAppStore.getState().saveSftpEditor({ force: true });
    });

    expect(writeTextFile).toHaveBeenCalledWith(
      expect.objectContaining({
        force: true,
        expectedSize: null,
        expectedMtime: null,
      }),
    );
  });

  // AWS SFTP 는 sync-api 브로커를 지나 이 연산이 없다.
  it("편집을 지원하지 않는 세션이면 이유를 남긴다", async () => {
    installRuntime({ readTextFile: undefined, writeTextFile: undefined });

    await act(async () => {
      await useMobileAppStore.getState().openSftpEditor(SFTP_ID, "/etc/app.conf");
    });

    const editor = useMobileAppStore.getState().sftpEditor;
    expect(editor?.isLoading).toBe(false);
    expect(editor?.errorMessage).toBeTruthy();
  });
});
