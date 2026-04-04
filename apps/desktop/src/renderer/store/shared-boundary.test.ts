import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const storeDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
);

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
  });
});
