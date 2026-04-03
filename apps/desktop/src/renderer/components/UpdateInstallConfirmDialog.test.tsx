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

    const backdrop = container.querySelector(".modal-backdrop") as HTMLElement;
    fireEvent.pointerDown(backdrop);
    fireEvent.click(backdrop);

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
