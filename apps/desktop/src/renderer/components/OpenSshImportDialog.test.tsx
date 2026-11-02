import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi, OpenSshHostPreview, OpenSshProbeResult } from "@shared";
import {
  OpenSshImportDialog,
  countOpenSshImportSecrets,
  filterOpenSshImportHosts,
} from "./OpenSshImportDialog";

const initialProbeResult: OpenSshProbeResult = {
  snapshotId: "snapshot-1",
  sources: [
    {
      id: "source:default",
      filePath: "C:/Users/tester/.ssh/config",
      origin: "default-ssh-dir",
      label: "~/.ssh/config",
    },
  ],
  warnings: [
    {
      code: "unsupported-host-pattern",
      message: "구체적인 별칭이 없는 Host 블록은 가져오지 않았습니다.",
    },
  ],
  hosts: [
    {
      key: "host-1",
      alias: "web",
      hostname: "web.example.com",
      port: 22,
      username: "ubuntu",
      authType: "privateKey",
      identityFilePath: "C:/Users/tester/.ssh/id_ed25519",
      sourceFilePath: "C:/Users/tester/.ssh/config",
      sourceLine: 4,
    },
  ],
  skippedExistingHostCount: 1,
  skippedDuplicateHostCount: 0,
};

const appendedProbeResult: OpenSshProbeResult = {
  ...initialProbeResult,
  sources: [
    ...initialProbeResult.sources,
    {
      id: "source:file",
      filePath: "D:/shared/team.conf",
      origin: "manual-file",
      label: "team.conf",
    },
  ],
  hosts: [
    ...initialProbeResult.hosts,
    {
      key: "host-2",
      alias: "db",
      hostname: "db.example.com",
      port: 2200,
      username: "postgres",
      authType: "password",
      identityFilePath: null,
      sourceFilePath: "D:/shared/team.conf",
      sourceLine: 9,
    },
  ],
  skippedExistingHostCount: 1,
  skippedDuplicateHostCount: 1,
};

const emptyProbeResult: OpenSshProbeResult = {
  snapshotId: "snapshot-empty",
  sources: [],
  hosts: [],
  warnings: [],
  skippedExistingHostCount: 0,
  skippedDuplicateHostCount: 0,
};

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function installMockApi() {
  const api = {
    openssh: {
      probeDefault: vi.fn().mockResolvedValue(initialProbeResult),
      addFileToSnapshot: vi.fn().mockResolvedValue(appendedProbeResult),
      importSelection: vi.fn().mockResolvedValue({
        createdHostCount: 2,
        createdSecretCount: 1,
        skippedHostCount: 0,
        warnings: [],
      }),
      discardSnapshot: vi.fn().mockResolvedValue(undefined),
    },
    shell: {
      pickOpenSshConfig: vi.fn().mockResolvedValue("D:/shared/team.conf"),
    },
  };

  Object.defineProperty(window, "dolssh", {
    configurable: true,
    value: api as unknown as DesktopApi,
  });

  return api;
}

describe("OpenSSH import dialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("filters hosts by alias, username, and key path metadata", () => {
    expect(filterOpenSshImportHosts(appendedProbeResult.hosts, "web")).toEqual([
      appendedProbeResult.hosts[0],
    ]);
    expect(
      filterOpenSshImportHosts(appendedProbeResult.hosts, "postgres"),
    ).toEqual([appendedProbeResult.hosts[1]]);
    expect(
      filterOpenSshImportHosts(appendedProbeResult.hosts, "id_ed25519"),
    ).toEqual([appendedProbeResult.hosts[0]]);
  });

  it("loads the default snapshot, appends manual files, and imports selected hosts into the current group", async () => {
    const api = installMockApi();
    const onClose = vi.fn();
    const onImported = vi.fn().mockResolvedValue(undefined);

    const { container } = render(
      <OpenSshImportDialog
        open
        currentGroupPath="Servers/Prod"
        onClose={onClose}
        onImported={onImported}
      />,
    );

    await waitFor(() => expect(api.openssh.probeDefault).toHaveBeenCalled());

    expect(screen.getByText("Import OpenSSH")).toBeInTheDocument();
    expect(await screen.findByText("web")).toBeInTheDocument();
    expect(screen.getByText("Servers/Prod")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "파일 불러오기" }));

    await waitFor(() =>
      expect(api.shell.pickOpenSshConfig).toHaveBeenCalled(),
    );
    await waitFor(() =>
      expect(api.openssh.addFileToSnapshot).toHaveBeenCalledWith({
        snapshotId: initialProbeResult.snapshotId,
        filePath: "D:/shared/team.conf",
      }),
    );

    expect(await screen.findByText("db")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "보이는 항목 모두 선택" }));
    fireEvent.click(screen.getByRole("button", { name: "가져오기" }));

    // onImported/onClose 는 importSelection 이 resolve 된 뒤에 불린다.
    await waitFor(() =>
      expect(onImported).toHaveBeenCalledWith({
        createdHostCount: 2,
        createdSecretCount: 1,
        skippedHostCount: 0,
        warnings: [],
      }),
    );
    expect(api.openssh.importSelection).toHaveBeenCalledWith({
      snapshotId: appendedProbeResult.snapshotId,
      selectedHostKeys: ["host-1", "host-2"],
      groupPath: "Servers/Prod",
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps the dialog usable when the default probe returns no hosts", async () => {
    const api = installMockApi();
    api.openssh.probeDefault.mockResolvedValueOnce(emptyProbeResult);

    const { container } = render(
      <OpenSshImportDialog
        open
        currentGroupPath={null}
        onClose={vi.fn()}
        onImported={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.openssh.probeDefault).toHaveBeenCalled());

    expect(
      screen.getByText("가져올 수 있는 OpenSSH 호스트가 없습니다."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "파일 불러오기" }),
    ).toBeInTheDocument();
  });

  it("closes when the backdrop is clicked while idle", async () => {
    const api = installMockApi();
    const onClose = vi.fn();
    const { container } = render(
      <OpenSshImportDialog
        open
        currentGroupPath={null}
        onClose={onClose}
        onImported={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.openssh.probeDefault).toHaveBeenCalled());

    const backdrop = container.querySelector(".modal-backdrop") as HTMLElement;
    fireEvent.pointerDown(backdrop);
    fireEvent.click(backdrop);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores backdrop clicks while a file is being appended", async () => {
    const api = installMockApi();
    const pendingAdd = createDeferred<OpenSshProbeResult>();
    api.openssh.addFileToSnapshot.mockReturnValueOnce(pendingAdd.promise);
    const onClose = vi.fn();

    const { container } = render(
      <OpenSshImportDialog
        open
        currentGroupPath={null}
        onClose={onClose}
        onImported={vi.fn()}
      />,
    );

    // 버튼은 첫 스냅샷이 도착한 뒤에 그려진다.
    fireEvent.click(await screen.findByRole("button", { name: "파일 불러오기" }));

    await waitFor(() =>
      expect(api.openssh.addFileToSnapshot).toHaveBeenCalled(),
    );

    const backdrop = container.querySelector(".modal-backdrop") as HTMLElement;
    fireEvent.pointerDown(backdrop);
    fireEvent.click(backdrop);

    expect(onClose).not.toHaveBeenCalled();

    pendingAdd.resolve(appendedProbeResult);
    await waitFor(() => expect(screen.getByText("db")).toBeInTheDocument());
  });
});

describe("OpenSSH import dialog — 어느 볼트로", () => {
  const TEAM = "team-1";
  const choices = [
    { id: "personal", team: null },
    { id: TEAM, team: { id: TEAM, name: "Acme Infra" } },
  ];

  function previewHost(key: string, identityFilePath: string | null): OpenSshHostPreview {
    return {
      key,
      alias: key,
      hostname: `${key}.example.test`,
      port: 22,
      username: "deploy",
      authType: identityFilePath ? "privateKey" : "password",
      identityFilePath,
      sourceFilePath: "/conf/config",
      sourceLine: 1,
    };
  }

  // web-1·web-2 는 같은 키 파일, api 는 다른 키, db 는 비밀번호(config 에는 비밀번호가 없다).
  const hosts = [
    previewHost("web-1", "/keys/id_deploy"),
    previewHost("web-2", "/keys/id_deploy"),
    previewHost("api", "/keys/id_api"),
    previewHost("db", null),
  ];

  function renderDialog(props: Partial<Parameters<typeof OpenSshImportDialog>[0]> = {}) {
    const api = installMockApi();
    api.openssh.probeDefault.mockResolvedValue({ ...emptyProbeResult, snapshotId: "snapshot-v", hosts });
    const onClose = vi.fn();
    const view = render(
      <OpenSshImportDialog
        open
        currentGroupPath="Prod"
        vaultChoices={choices}
        defaultVaultId={TEAM}
        onClose={onClose}
        onImported={vi.fn()}
        {...props}
      />,
    );
    return { api, onClose, view };
  }

  const shareSwitch = () => screen.queryByRole("switch");
  const targetLine = () => screen.getByText("대상 그룹").parentElement!;
  const pickVault = (name: string) => {
    fireEvent.click(screen.getByRole("button", { name: "Vault" }));
    fireEvent.click(within(screen.getByRole("listbox", { name: /Vault/ })).getByRole("option", { name }));
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("counts each key file once among the selected hosts", () => {
    expect(countOpenSshImportSecrets(hosts, ["web-1", "web-2", "db"])).toBe(1);
    expect(countOpenSshImportSecrets(hosts, ["web-1", "web-2", "api", "db"])).toBe(2);
    expect(countOpenSshImportSecrets(hosts, ["db"])).toBe(0);
    expect(countOpenSshImportSecrets(hosts, [])).toBe(0);
    // 키 인증인데 키 파일을 못 찾은 호스트는 넣을 키가 없다.
    expect(countOpenSshImportSecrets([{ ...hosts[0]!, identityFilePath: null }], ["web-1"])).toBe(0);
  });

  it("starts on the vault it was opened from, into the group there, and shares the keys with the team", async () => {
    const { api, onClose } = renderDialog();

    expect(screen.getByRole("button", { name: "Vault" })).toHaveTextContent("Acme Infra");
    expect(targetLine()).toHaveTextContent("Prod");
    fireEvent.click(await screen.findByRole("button", { name: "보이는 항목 모두 선택" }));

    expect(shareSwitch()).toHaveAccessibleName("비밀번호·SSH 키 2개도 함께 공유");
    expect(shareSwitch()).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: "가져오기" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.openssh.importSelection).toHaveBeenCalledWith({
      snapshotId: "snapshot-v",
      selectedHostKeys: ["web-1", "web-2", "api", "db"],
      groupPath: "Prod",
      vaultId: TEAM,
      shareSecrets: true,
    });
  });

  it("keeps the keys out of the team when sharing is turned off", async () => {
    const { api, onClose } = renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "보이는 항목 모두 선택" }));

    fireEvent.click(shareSwitch()!);
    expect(shareSwitch()).toHaveAttribute("aria-checked", "false");
    fireEvent.click(screen.getByRole("button", { name: "가져오기" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.openssh.importSelection).toHaveBeenCalledWith(
      expect.objectContaining({ vaultId: TEAM, shareSecrets: false }),
    );
  });

  it("leaves the group behind and drops the sharing line when you pick your own vault", async () => {
    const { api, onClose } = renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "보이는 항목 모두 선택" }));
    expect(shareSwitch()).not.toBeNull();

    pickVault("Personal");

    expect(screen.getByRole("button", { name: "Vault" })).toHaveTextContent("Personal");
    expect(shareSwitch()).toBeNull();
    expect(targetLine()).toHaveTextContent("미분류");
    fireEvent.click(screen.getByRole("button", { name: "가져오기" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    // 개인이면 요청은 지금까지와 같다 — 볼트를 싣지 않는다.
    expect(api.openssh.importSelection).toHaveBeenCalledWith({
      snapshotId: "snapshot-v",
      selectedHostKeys: ["web-1", "web-2", "api", "db"],
      groupPath: null,
    });
  });

  it("goes to the top of a team picked from your own vault", async () => {
    const { api, onClose } = renderDialog({ defaultVaultId: "personal", currentGroupPath: "Servers" });
    expect(targetLine()).toHaveTextContent("Servers");
    fireEvent.click(await screen.findByRole("button", { name: "보이는 항목 모두 선택" }));
    expect(shareSwitch()).toBeNull();

    pickVault("Acme Infra");

    expect(targetLine()).toHaveTextContent("미분류");
    expect(shareSwitch()).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: "가져오기" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.openssh.importSelection).toHaveBeenCalledWith(
      expect.objectContaining({ groupPath: null, vaultId: TEAM, shareSecrets: true }),
    );
  });

  it("shows the sharing line only once a selected host brings a key", async () => {
    renderDialog();
    fireEvent.click(await screen.findByRole("checkbox", { name: /^db/ }));
    expect(shareSwitch()).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: /^web-1/ }));
    expect(shareSwitch()).toHaveAccessibleName("비밀번호·SSH 키 1개도 함께 공유");
  });

  it("has no Vault field with only your own vault", async () => {
    renderDialog({ vaultChoices: [choices[0]!], defaultVaultId: "personal" });
    fireEvent.click(await screen.findByRole("button", { name: "보이는 항목 모두 선택" }));

    expect(screen.queryByRole("button", { name: "Vault" })).toBeNull();
    expect(shareSwitch()).toBeNull();
  });

  it("opens again on the vault it was opened from, with sharing on", async () => {
    const { view } = renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "보이는 항목 모두 선택" }));
    fireEvent.click(shareSwitch()!);
    pickVault("Personal");

    const props = { currentGroupPath: "Prod", vaultChoices: choices, defaultVaultId: TEAM, onClose: vi.fn(), onImported: vi.fn() };
    view.rerender(<OpenSshImportDialog open={false} {...props} />);
    view.rerender(<OpenSshImportDialog open {...props} />);

    expect(screen.getByRole("button", { name: "Vault" })).toHaveTextContent("Acme Infra");
    fireEvent.click(await screen.findByRole("button", { name: "보이는 항목 모두 선택" }));
    expect(shareSwitch()).toHaveAttribute("aria-checked", "true");
  });

  it("holds the vault and the sharing switch still while importing", async () => {
    const { api } = renderDialog();
    api.openssh.importSelection.mockReturnValueOnce(new Promise(() => undefined));
    fireEvent.click(await screen.findByRole("button", { name: "보이는 항목 모두 선택" }));
    fireEvent.click(screen.getByRole("button", { name: "가져오기" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Vault" })).toBeDisabled());
    expect(shareSwitch()).toBeDisabled();
  });
});
