import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopApi,
  WarpgateConnectionInfo,
  WarpgateImportEvent,
  WarpgateTargetSummary,
} from "@shared";
import { WarpgateImportDialog } from "./WarpgateImportDialog";

const connectionInfoWithoutUsername: WarpgateConnectionInfo = {
  baseUrl: "https://warpgate.example.com",
  sshHost: "ssh.warpgate.example.com",
  sshPort: 2222,
  username: null,
};

const sshTargets: WarpgateTargetSummary[] = [
  {
    id: "target-1",
    name: "prod-db",
    kind: "ssh",
  },
];

function installMockApi(
  connectionInfo: WarpgateConnectionInfo = connectionInfoWithoutUsername,
) {
  const listeners = new Set<(event: WarpgateImportEvent) => void>();
  const api = {
    warpgate: {
      startBrowserImport: vi.fn().mockResolvedValue({ attemptId: "attempt-1" }),
      cancelBrowserImport: vi.fn().mockResolvedValue(undefined),
      onImportEvent: vi.fn((listener: (event: WarpgateImportEvent) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }),
    },
  };

  Object.defineProperty(window, "dolssh", {
    configurable: true,
    value: api as unknown as DesktopApi,
  });

  return {
    api,
    emitImportEvent(
      event: Partial<WarpgateImportEvent> & Pick<WarpgateImportEvent, "status">,
    ) {
      const payload: WarpgateImportEvent = {
        attemptId: "attempt-1",
        connectionInfo: null,
        targets: null,
        errorMessage: null,
        ...event,
      };
      if (payload.status === "completed") {
        payload.connectionInfo ??= connectionInfo;
        payload.targets ??= sshTargets;
      }
      for (const listener of listeners) {
        listener(payload);
      }
    },
  };
}

async function startBrowserImport() {
  fireEvent.change(screen.getByPlaceholderText("https://warpgate.example.com"), {
    target: { value: "https://warpgate.example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: "브라우저에서 로그인" }));
  await waitFor(() =>
    expect(window.dolssh.warpgate.startBrowserImport).toHaveBeenCalledWith(
      "https://warpgate.example.com",
    ),
  );
}

describe("Warpgate import dialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("removes the token input and renders browser-login progress and targets", async () => {
    const { emitImportEvent } = installMockApi();

    render(
      <WarpgateImportDialog
        open
        currentGroupPath={null}
        onClose={vi.fn()}
        onImport={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(
      screen.queryByPlaceholderText("Paste your Warpgate API token"),
    ).not.toBeInTheDocument();

    await startBrowserImport();
    expect(screen.getByText("인증 창을 여는 중입니다.")).toBeInTheDocument();

    emitImportEvent({ status: "waiting-for-login" });
    expect(
      await screen.findByText("Warpgate 로그인 완료를 기다리는 중입니다."),
    ).toBeInTheDocument();

    emitImportEvent({ status: "loading-targets" });
    expect(
      await screen.findByText("SSH target 목록을 불러오는 중입니다."),
    ).toBeInTheDocument();

    emitImportEvent({ status: "completed" });
    expect(await screen.findByText("prod-db")).toBeInTheDocument();
  });

  it("shows a validation error when add host is clicked without a username", async () => {
    const { emitImportEvent } = installMockApi();
    const onImport = vi.fn().mockResolvedValue(undefined);

    render(
      <WarpgateImportDialog
        open
        currentGroupPath={null}
        onClose={vi.fn()}
        onImport={onImport}
      />,
    );

    await startBrowserImport();
    emitImportEvent({ status: "completed" });

    const addHostButton = await screen.findByRole("button", {
      name: "Add host",
    });
    expect(addHostButton).toBeEnabled();

    fireEvent.click(addHostButton);

    expect(
      await screen.findByText("Warpgate 사용자명을 입력해 주세요."),
    ).toBeInTheDocument();
    expect(onImport).not.toHaveBeenCalled();
  });

  it("imports the selected target after a fallback username is entered", async () => {
    const { emitImportEvent } = installMockApi();
    const onImport = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();

    render(
      <WarpgateImportDialog
        open
        currentGroupPath="Servers/Prod"
        onClose={onClose}
        onImport={onImport}
      />,
    );

    await startBrowserImport();
    emitImportEvent({ status: "completed" });

    fireEvent.click(await screen.findByRole("button", { name: "Add host" }));
    expect(
      await screen.findByText("Warpgate 사용자명을 입력해 주세요."),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("example.user"), {
      target: { value: "example.user" },
    });

    await waitFor(() =>
      expect(
        screen.queryByText("Warpgate 사용자명을 입력해 주세요."),
      ).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Add host" }));

    await waitFor(() =>
      expect(onImport).toHaveBeenCalledWith({
        kind: "warpgate-ssh",
        label: "prod-db",
        groupName: "Servers/Prod",
        tags: [],
        terminalThemeId: null,
        warpgateBaseUrl: "https://warpgate.example.com",
        warpgateSshHost: "ssh.warpgate.example.com",
        warpgateSshPort: 2222,
        warpgateTargetId: "target-1",
        warpgateTargetName: "prod-db",
        warpgateUsername: "example.user",
      }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("cancels the active browser import when the dialog is closed", async () => {
    const { api } = installMockApi();
    const onClose = vi.fn();

    render(
      <WarpgateImportDialog
        open
        currentGroupPath={null}
        onClose={onClose}
        onImport={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await startBrowserImport();

    fireEvent.click(
      screen.getByRole("button", { name: "Close Warpgate import dialog" }),
    );

    await waitFor(() =>
      expect(api.warpgate.cancelBrowserImport).toHaveBeenCalledWith("attempt-1"),
    );
    expect(onClose).toHaveBeenCalled();
  });
});
