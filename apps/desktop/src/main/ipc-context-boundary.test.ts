import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const mainDir = path.dirname(fileURLToPath(import.meta.url));
const factoryPath = path.join(mainDir, "ipc-context-factory.ts");
const ipcDir = path.join(mainDir, "ipc");

describe("main IPC composition boundary", () => {
  it("keeps the IPC context factory as a thin composition root", () => {
    const content = fs.readFileSync(factoryPath, "utf8");
    const lineCount = content.trimEnd().split(/\r?\n/).length;

    expect(lineCount).toBeLessThanOrEqual(300);
    expect(content).not.toContain("createServer");
    expect(content).not.toContain("generateKeyPairSync");
    expect(content).not.toContain("BrowserWindow.getAllWindows");
    expect(content).not.toContain("inferAwsSftpDiagnosticReasonCode");
    expect(content).not.toContain("new Map<");
  });

  it("keeps direct ipcMain.handle registration inside feature handlers only", () => {
    const offenders: string[] = [];
    const entries = fs.readdirSync(mainDir);
    for (const entry of entries) {
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) {
        continue;
      }
      const fullPath = path.join(mainDir, entry);
      const content = fs.readFileSync(fullPath, "utf8");
      if (content.includes("ipcMain.handle")) {
        offenders.push(path.relative(mainDir, fullPath));
      }
    }

    expect(offenders).toEqual([]);
    expect(
      fs
        .readdirSync(ipcDir)
        .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
        .some((entry) =>
          fs.readFileSync(path.join(ipcDir, entry), "utf8").includes("ipcMain.handle"),
        ),
    ).toBe(true);
  });
});
