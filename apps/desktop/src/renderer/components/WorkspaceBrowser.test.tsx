import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SavedWorkspaceRecord } from "@shared";
import { WorkspaceBrowser } from "./WorkspaceBrowser";

function record(): SavedWorkspaceRecord {
  return {
    id: "workspace-1",
    version: 1,
    name: "Production checks",
    root: {
      id: "root",
      kind: "split",
      axis: "horizontal",
      ratio: 0.65,
      first: {
        id: "prod-pane",
        kind: "leaf",
        target: { kind: "host", hostId: "host-1", label: "Prod" },
      },
      second: {
        id: "local-pane",
        kind: "leaf",
        target: { kind: "local", label: "Local shell" },
      },
    },
    favorite: false,
    lastOpenedAt: "2026-09-05T10:00:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-05T10:00:00.000Z",
  };
}

function renderBrowser(overrides: Record<string, unknown> = {}) {
  const props = {
    sidebar: <div>Shared sidebar</div>,
    workspaces: [record()],
    hosts: [{ id: "host-1", kind: "ssh", label: "Prod" }],
    activityLogs: [
      {
        id: "log-1",
        level: "info",
        category: "session",
        message: "Connected to Prod",
        metadata: { hostId: "host-1" },
        createdAt: "2026-09-05T09:00:00.000Z",
      },
    ],
    onOpen: vi.fn(),
    onRename: vi.fn().mockResolvedValue(undefined),
    onDuplicate: vi.fn().mockResolvedValue(undefined),
    onToggleFavorite: vi.fn().mockResolvedValue(undefined),
    onDelete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  render(
    <WorkspaceBrowser
      {...(props as unknown as Parameters<typeof WorkspaceBrowser>[0])}
    />,
  );
  return props;
}

describe("WorkspaceBrowser", () => {
  it("keeps sidebar, cards, and selected Workspace details in one three-column view", async () => {
    renderBrowser();

    expect(screen.getByText("Shared sidebar")).toBeInTheDocument();
    expect(
      screen.getAllByText("Production checks").length,
    ).toBeGreaterThanOrEqual(2);
    expect(await screen.findByText("Pane 배치")).toBeInTheDocument();
    expect(screen.getAllByText("Prod").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Local shell").length).toBeGreaterThan(0);
    expect(screen.getByText("Connected to Prod")).toBeInTheDocument();
  });

  it("labels every recent activity entry with its Host name", async () => {
    const workspace = record();
    if (workspace.root.kind !== "split") {
      throw new Error("Expected split Workspace fixture");
    }
    workspace.root.second = {
      id: "db-pane",
      kind: "leaf",
      target: { kind: "host", hostId: "host-2", label: "DB snapshot" },
    };

    renderBrowser({
      workspaces: [workspace],
      hosts: [
        { id: "host-1", kind: "ssh", label: "Prod API" },
        { id: "host-2", kind: "ssh", label: "Primary DB" },
      ],
      activityLogs: [
        {
          id: "log-api",
          level: "info",
          category: "session",
          message: "API connected",
          metadata: { hostId: "host-1" },
          createdAt: "2026-09-05T09:00:00.000Z",
        },
        {
          id: "log-db",
          level: "warn",
          category: "session",
          message: "DB reconnecting",
          metadata: { hostId: "host-2" },
          createdAt: "2026-09-05T08:59:00.000Z",
        },
      ],
    });

    const recentActivity = (await screen.findByText("최근 활동")).closest(
      "section",
    );
    expect(recentActivity).not.toBeNull();
    const activity = within(recentActivity as HTMLElement);
    expect(activity.getByText("Prod API")).toBeInTheDocument();
    expect(activity.getByText("API connected")).toBeInTheDocument();
    expect(activity.getByText("Primary DB")).toBeInTheDocument();
    expect(activity.getByText("DB reconnecting")).toBeInTheDocument();
  });

  it("renames through the detail-panel dialog", async () => {
    const props = renderBrowser();
    fireEvent.click(await screen.findByRole("button", { name: "이름 변경" }));

    const input = screen.getByLabelText("Workspace 이름");
    expect(input).toHaveValue("Production checks");
    fireEvent.change(input, { target: { value: "Incident response" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() =>
      expect(props.onRename).toHaveBeenCalledWith(
        "workspace-1",
        "Incident response",
      ),
    );
  });

  it("requires confirmation before deleting a saved Workspace", async () => {
    const props = renderBrowser();
    fireEvent.click(await screen.findByRole("button", { name: "삭제" }));

    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("Production checks");
    fireEvent.click(within(dialog).getByRole("button", { name: "삭제" }));

    await waitFor(() =>
      expect(props.onDelete).toHaveBeenCalledWith("workspace-1"),
    );
  });
});
