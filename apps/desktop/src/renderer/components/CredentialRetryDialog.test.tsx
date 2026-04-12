import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CredentialRetryDialog } from "./CredentialRetryDialog";

describe("CredentialRetryDialog", () => {
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
          hasLegacyPrivateKeyPath: false,
          hasLegacyCertificatePath: false,
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
          hasLegacyPrivateKeyPath: false,
          hasLegacyCertificatePath: false,
        }}
        onClose={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByLabelText("Username")).toHaveValue("ubuntu");
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  it("renders certificate auth fields together", () => {
    render(
      <CredentialRetryDialog
        request={{
          hostId: "host-1",
          hostLabel: "Prod SSH",
          source: "ssh",
          authType: "certificate",
          message: "authentication failed",
          initialUsername: "ubuntu",
          hasStoredSecret: false,
          hasLegacyPrivateKeyPath: false,
          hasLegacyCertificatePath: false,
        }}
        onClose={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByLabelText("Username")).toBeInTheDocument();
    expect(screen.getByLabelText("Private key file")).toBeInTheDocument();
    expect(screen.getByLabelText("SSH certificate file")).toBeInTheDocument();
    expect(screen.getByLabelText("Passphrase")).toBeInTheDocument();
  });
});
