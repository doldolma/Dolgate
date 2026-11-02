import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialRetryDialog } from "./CredentialRetryDialog";
import { useHostFormController } from "../controllers/useHostFormController";
import { loadSavedCredential } from "../services/desktop/settings";
import { t } from "../i18n";

vi.mock("../controllers/useHostFormController", () => ({
  useHostFormController: vi.fn(() => ({
    listSerialPorts: vi.fn().mockResolvedValue([]),
    pickPrivateKey: vi.fn(),
    pickSshCertificate: vi.fn(),
  })),
}));

vi.mock("../services/desktop/settings", () => ({
  loadSavedCredential: vi.fn(),
  pickPrivateKey: vi.fn(),
  pickSshCertificate: vi.fn(),
}));

describe("CredentialRetryDialog", () => {
  beforeEach(() => {
    vi.mocked(loadSavedCredential).mockReset();
    vi.mocked(useHostFormController).mockImplementation(() => ({
      listSerialPorts: vi.fn().mockResolvedValue([]),
      pickPrivateKey: vi.fn(),
      pickSshCertificate: vi.fn(),
      probeSshAgent: vi.fn().mockResolvedValue({ status: 'unknown' }),
    }));
  });

  it("does not close when the backdrop is clicked", () => {
    const onClose = vi.fn();
    const { container } = render(
      <CredentialRetryDialog
        request={{
          hostId: "host-1",
          hostLabel: "Prod SSH",
          source: "ssh",
          authType: "password",
          message: "비밀번호를 다시 입력해 주세요.",
          initialUsername: "ubuntu",
          hasStoredSecret: true,
        }}
        onClose={onClose}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const backdrop = container.querySelector(".modal-backdrop") as HTMLElement;
    fireEvent.pointerDown(backdrop);
    fireEvent.click(backdrop);

    expect(onClose).not.toHaveBeenCalled();
  });

  it("renders username and password fields for password auth", () => {
    render(
      <CredentialRetryDialog
        request={{
          hostId: "host-1",
          hostLabel: "Prod SSH",
          source: "ssh",
          authType: "password",
          message: "authentication failed",
          initialUsername: "ubuntu",
          hasStoredSecret: true,
        }}
        onClose={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByLabelText("Username")).toHaveValue("ubuntu");
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  it("renders certificate auth fields together", async () => {
    vi.mocked(loadSavedCredential).mockResolvedValue({
      secretRef: "secret-1",
      label: "Prod cert",
      privateKeyPem: "PRIVATE KEY",
      certificateText: "CERTIFICATE",
      updatedAt: "2026-04-12T00:00:00.000Z",
      certificateInfo: {
        status: "expired",
        validBefore: "2026-04-11T00:00:00.000Z",
        principals: ["ubuntu"],
      },
    });

    render(
      <CredentialRetryDialog
        request={{
          hostId: "host-1",
          hostLabel: "Prod SSH",
          source: "ssh",
          authType: "certificate",
          message:
            "Error invoking remote method 'ssh:connect': Error: SSH 인증서가 만료되었습니다. 새 인증서를 가져와 다시 시도하세요.",
          initialUsername: "ubuntu",
          hasStoredSecret: false,
          secretRef: "secret-1",
        }}
        onClose={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByLabelText("Username")).toBeInTheDocument();
    expect(screen.getByLabelText("Private key file")).toBeInTheDocument();
    expect(screen.getByLabelText("SSH certificate file")).toBeInTheDocument();
    expect(screen.getByLabelText("Passphrase")).toBeInTheDocument();
    expect(await screen.findByText(/Expired on/)).toBeInTheDocument();
    expect(
      screen.queryByText(/Error invoking remote method 'ssh:connect'/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/SSH 인증서가 만료되었습니다/),
    ).not.toBeInTheDocument();
  });

  it("does not show a certificate summary card when the certificate is still valid", async () => {
    vi.mocked(loadSavedCredential).mockResolvedValue({
      secretRef: "secret-1",
      label: "Prod cert",
      privateKeyPem: "PRIVATE KEY",
      certificateText: "CERTIFICATE",
      updatedAt: "2026-04-12T00:00:00.000Z",
      certificateInfo: {
        status: "valid",
        validBefore: "2027-04-11T10:58:00.000Z",
        principals: ["testuser"],
      },
    });

    render(
      <CredentialRetryDialog
        request={{
          hostId: "host-1",
          hostLabel: "Prod SSH",
          source: "ssh",
          authType: "certificate",
          message:
            "ssh handshake failed: ssh: handshake failed: ssh: unexpected message type 51 (expected 60)",
          initialUsername: "ubuntu",
          hasStoredSecret: false,
          secretRef: "secret-1",
        }}
        onClose={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByText(/unexpected message type 51/i)).toBeInTheDocument();
    expect(screen.queryByText(/Valid until/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Principals:/)).not.toBeInTheDocument();
  });
});

// 다듬기 3단계 — VNC 호스트 자신의 값은 같은 요청 창으로 묻는다. 비밀번호만, 계정으로 로그인하는 서버면 계정도.
describe("CredentialRetryDialog for a VNC host", () => {
  const base = {
    hostId: "vnc-1",
    hostLabel: "Desk",
    source: "vnc" as const,
    authType: "password" as const,
    message: "Desk VNC 비밀번호를 넣어 주세요.",
    initialUsername: "",
    // 저장된 값이 있어도(방금 거절됨) 비밀번호는 새로 넣어야 한다.
    hasStoredSecret: true,
  };

  it("asks only for the password under a VNC heading", () => {
    render(
      <CredentialRetryDialog
        request={{ ...base, vncFailure: "password-required" }}
        onClose={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.getByText("VNC Retry")).toBeInTheDocument();
    expect(screen.queryByLabelText("Username")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toHaveFocus();
  });

  it("asks for the account too on a server that logs in with one, filled with the one it used", () => {
    render(
      <CredentialRetryDialog
        request={{ ...base, vncFailure: "account-auth-rejected", initialUsername: "alice" }}
        onClose={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.getByLabelText("Username")).toHaveValue("alice");
    expect(screen.getByLabelText("Username")).toHaveFocus();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  it("requires a new password even when one is stored", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<CredentialRetryDialog request={{ ...base, vncFailure: "auth-rejected" }} onClose={vi.fn()} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: t("credentialRetry.retry") }));
    expect(await screen.findByText(t("credentialRetry.passwordRequired"))).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("sends the typed password without asking for a username", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<CredentialRetryDialog request={{ ...base, vncFailure: "password-required" }} onClose={vi.fn()} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "typed" } });
    fireEvent.click(screen.getByRole("button", { name: t("credentialRetry.retry") }));
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ username: "", password: "typed" })));
  });

  it("requires the account only where the server needs one", async () => {
    const needsAccount = vi.fn().mockResolvedValue(undefined);
    const first = render(
      <CredentialRetryDialog request={{ ...base, vncFailure: "account-required" }} onClose={vi.fn()} onSubmit={needsAccount} />,
    );
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: t("credentialRetry.retry") }));
    expect(await screen.findByText(t("credentialRetry.usernameRequired"))).toBeInTheDocument();
    expect(needsAccount).not.toHaveBeenCalled();
    first.unmount();

    // 계정이 거절된 서버는 계정을 비워 VNC 암호로 붙을 수 있다.
    const mayClear = vi.fn().mockResolvedValue(undefined);
    render(
      <CredentialRetryDialog
        request={{ ...base, vncFailure: "account-auth-rejected", initialUsername: "alice" }}
        onClose={vi.fn()}
        onSubmit={mayClear}
      />,
    );
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: t("credentialRetry.retry") }));
    await vi.waitFor(() => expect(mayClear).toHaveBeenCalledWith(expect.objectContaining({ username: "", password: "pw" })));
  });
});
