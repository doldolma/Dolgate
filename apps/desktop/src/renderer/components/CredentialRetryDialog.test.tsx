import { fireEvent, render } from "@testing-library/react";
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
          credentialKind: "password",
          message: "비밀번호를 다시 입력해 주세요.",
        }}
        onClose={onClose}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    fireEvent.click(container.querySelector(".modal-backdrop") as HTMLElement);

    expect(onClose).not.toHaveBeenCalled();
  });
});
