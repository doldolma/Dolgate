import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UpdateInstallConfirmDialog } from "./UpdateInstallConfirmDialog";

describe("UpdateInstallConfirmDialog", () => {
  it("treats backdrop clicks as cancel", () => {
    const onClose = vi.fn();
    const { container } = render(
      <UpdateInstallConfirmDialog
        open
        onClose={onClose}
        onConfirm={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    fireEvent.click(container.querySelector(".modal-backdrop") as HTMLElement);

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
