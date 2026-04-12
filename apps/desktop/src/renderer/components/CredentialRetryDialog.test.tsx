import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialRetryDialog } from "./CredentialRetryDialog";
import { useHostFormController } from "../controllers/useHostFormController";
import { loadSavedCredential } from "../services/desktop/settings";

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
