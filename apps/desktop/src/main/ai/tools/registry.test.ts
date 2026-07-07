import { describe, expect, it } from "vitest";
import { buildToolRegistry } from "./registry";

const BASE = { webSearch: true, fetchUrl: true, searchBackend: "duckduckgo" as const, searchKey: null };

describe("buildToolRegistry", () => {
  it("exposes web_search and fetch_url but no host tools by default", () => {
    const names = buildToolRegistry(BASE).defs.map((def) => def.name);
    expect(names).toContain("web_search");
    expect(names).toContain("fetch_url");
    expect(names).not.toContain("run_in_terminal");
    expect(names).not.toContain("inspect_command");
  });

  it("exposes run_in_terminal only when the terminal capability is provided", () => {
    const registry = buildToolRegistry({
      ...BASE,
      runInTerminal: async () => ({ output: "", running: false }),
    });
    expect(registry.defs.map((def) => def.name)).toContain("run_in_terminal");
    expect(registry.executors.has("run_in_terminal")).toBe(true);
    expect(registry.defs.map((def) => def.name)).not.toContain("inspect_command");
  });

  it("exposes inspect_command only when the exec-capture capability is provided", () => {
    const registry = buildToolRegistry({
      ...BASE,
      execCapture: async () => ({ stdout: "", stderr: "", exitCode: 0, truncated: false }),
    });
    expect(registry.defs.map((def) => def.name)).toContain("inspect_command");
    expect(registry.executors.has("inspect_command")).toBe(true);
    expect(registry.defs.map((def) => def.name)).not.toContain("run_in_terminal");
  });
});
