import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    expect(
      screen.getByText("Warpgate 로그인 창을 여는 중입니다."),
    ).toBeInTheDocument();

    emitImportEvent({ status: "waiting-for-login" });
    expect(
      await screen.findByText("Warpgate 로그인 창이 열려 있습니다."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("로그인을 완료하거나 아래에서 중단할 수 있습니다."),
    ).toBeInTheDocument();

    emitImportEvent({ status: "loading-targets" });
    expect(
      await screen.findByText("Warpgate 로그인은 완료되었습니다."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("SSH target 목록을 불러오는 중입니다."),
    ).toBeInTheDocument();

    emitImportEvent({ status: "completed" });
    expect(await screen.findByText("prod-db")).toBeInTheDocument();
  });

  it("lets the user stop an active browser import without closing the dialog", async () => {
    const { api, emitImportEvent } = installMockApi();
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
    emitImportEvent({ status: "waiting-for-login" });

    fireEvent.click(await screen.findByRole("button", { name: "중단" }));

    await waitFor(() =>
      expect(api.warpgate.cancelBrowserImport).toHaveBeenCalledWith("attempt-1"),
    );
    expect(onClose).not.toHaveBeenCalled();

    emitImportEvent({ status: "cancelled" });

    expect(
      await screen.findByText("Warpgate 로그인을 중단했습니다."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("주소를 확인한 뒤 다시 시도할 수 있습니다."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "브라우저에서 로그인" }),
    ).toBeEnabled();
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
      }, "personal"),
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

describe("Warpgate import dialog — 어느 볼트로", () => {
  const TEAM = "team-1";
  const choices = [
    { id: "personal", team: null },
    { id: TEAM, team: { id: TEAM, name: "Acme Infra" } },
  ];
  const withUsername = { ...connectionInfoWithoutUsername, username: "example.user" };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("adds the target to the vault it was opened from, into the group there", async () => {
    const { emitImportEvent } = installMockApi(withUsername);
    const onImport = vi.fn().mockResolvedValue(undefined);
    render(
      <WarpgateImportDialog
        open
        currentGroupPath="Prod"
        vaultChoices={choices}
        defaultVaultId={TEAM}
        onClose={vi.fn()}
        onImport={onImport}
      />,
    );

    expect(screen.getByRole("button", { name: "Vault" })).toHaveTextContent("Acme Infra");
    await startBrowserImport();
    emitImportEvent({ status: "completed" });
    fireEvent.click(await screen.findByRole("button", { name: "Add host" }));

    await waitFor(() => expect(onImport).toHaveBeenCalled());
    expect(onImport.mock.lastCall?.[0]).toMatchObject({ kind: "warpgate-ssh", groupName: "Prod" });
    expect(onImport.mock.lastCall?.[1]).toBe(TEAM);
    // Warpgate 호스트에는 비밀값이 없다 — 공유 줄이 없다.
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("adds the target to the top of another vault you pick", async () => {
    const { emitImportEvent } = installMockApi(withUsername);
    const onImport = vi.fn().mockResolvedValue(undefined);
    render(
      <WarpgateImportDialog
        open
        currentGroupPath="Prod"
        vaultChoices={choices}
        defaultVaultId={TEAM}
        onClose={vi.fn()}
        onImport={onImport}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Vault" }));
    fireEvent.click(within(screen.getByRole("listbox", { name: /Vault/ })).getByRole("option", { name: "Personal" }));
    await startBrowserImport();
    emitImportEvent({ status: "completed" });
    fireEvent.click(await screen.findByRole("button", { name: "Add host" }));

    await waitFor(() => expect(onImport).toHaveBeenCalled());
    expect(onImport.mock.lastCall?.[0]).toMatchObject({ groupName: "" });
    expect(onImport.mock.lastCall?.[1]).toBe("personal");
  });
});
