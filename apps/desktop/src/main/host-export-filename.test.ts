import { describe, expect, it } from "vitest";
import { createHostExportFileName } from "./host-export-filename";

describe("createHostExportFileName", () => {
  const localTime = new Date(2026, 6, 22, 19, 26, 45);

  it("creates a timestamped Dolgate host export name", () => {
    expect(createHostExportFileName("dolgate", localTime)).toBe(
      "hosts-20260722-192645.dolgate",
    );
  });

  it("uses the same timestamp format for OpenSSH exports", () => {
    expect(createHostExportFileName("ssh-config", localTime)).toBe(
      "hosts-20260722-192645.ssh-config",
    );
  });
});
