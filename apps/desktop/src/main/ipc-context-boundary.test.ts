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

    // 상한은 "얇은 조합 루트" 유지를 위한 소프트 캡이다. 서비스가 추가되면(예: AiService)
    // 한 줄짜리 조합이 늘 수 있으므로 약간의 여유를 둔다. 진짜 가드는 아래의 로직 금지 단언들이다.
    expect(lineCount).toBeLessThanOrEqual(320);
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
