import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const storeDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
);
const sharedDir = path.resolve(storeDir, "..", "..", "shared");
const desktopDir = path.resolve(sharedDir, "..", "..");

describe("store shared boundary", () => {
  it("keeps slices and service factories free of legacy shared imports", () => {
    const targets = [
      path.join(storeDir, "slices"),
      path.join(storeDir, "services"),
    ];

    const offenders: string[] = [];
    for (const target of targets) {
      for (const entry of fs.readdirSync(target)) {
        if (!entry.endsWith(".ts")) {
          continue;
        }
        const fullPath = path.join(target, entry);
        const content = fs.readFileSync(fullPath, "utf8");
        if (
          content.includes("../services/shared") ||
          content.includes('./shared') ||
          content.includes("\"./shared\"") ||
          content.includes("../services/service-core") ||
          content.includes("./service-core") ||
          content.includes("createSharedServices(") ||
          content.includes("../bindings") ||
          content.includes("./bindings")
        ) {
          offenders.push(path.relative(storeDir, fullPath));
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("removes the legacy central service files", () => {
    expect(fs.existsSync(path.join(storeDir, "services", "service-core.ts"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(storeDir, "bindings.ts"))).toBe(false);
    expect(fs.existsSync(path.join(storeDir, "utils", "core.ts"))).toBe(false);
  });

  it("keeps slices on named domain helpers instead of the old core barrel", () => {
    const offenders: string[] = [];
    const slicesDir = path.join(storeDir, "slices");
    for (const entry of fs.readdirSync(slicesDir)) {
      if (!entry.endsWith(".ts")) {
        continue;
      }
      const fullPath = path.join(slicesDir, entry);
      const content = fs.readFileSync(fullPath, "utf8");
      if (
        content.includes("../utils/core") ||
        content.includes("import * as utils") ||
        content.includes("import * as defaults") ||
        content.includes("{ ...defaults, ...utils }")
      ) {
        offenders.push(path.relative(storeDir, fullPath));
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps desktop shared as a facade over shared-core plus IPC types", () => {
    expect(fs.readdirSync(sharedDir).sort()).toEqual(["index.ts", "ipc.ts"]);
  });

  it("loads shared-core source directly instead of a stale Vite dependency cache", () => {
    const viteConfig = fs.readFileSync(
      path.join(desktopDir, "vite.base.config.ts"),
      "utf8",
    );

    expect(viteConfig).toContain("exclude: ['@dolssh/shared-core']");
  });
});
