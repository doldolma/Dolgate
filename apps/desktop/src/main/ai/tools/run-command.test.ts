import { describe, expect, it, vi } from "vitest";
import { runInTerminalTool } from "./run-command";

const runner = (output: string, running = false) =>
  vi.fn().mockResolvedValue({ output, running });

describe("runInTerminalTool", () => {
  it("types the command and returns the captured output", async () => {
    const run = runner("Filesystem  Size\n/dev/sda  100G");
    const out = await runInTerminalTool({ command: "df -h" }, run);
    expect(run).toHaveBeenCalledWith("df -h");
    expect(out).toContain("df -h");
    expect(out).toContain("/dev/sda");
  });

  it("trims the command before running", async () => {
    const run = runner("");
    await runInTerminalTool({ command: "  ls -la  " }, run);
    expect(run).toHaveBeenCalledWith("ls -la");
  });

  it("marks still-running (streaming) output so the model does not re-run", async () => {
    const run = runner("log line 1\nlog line 2", true);
    const out = await runInTerminalTool({ command: "docker logs -f x" }, run);
    expect(out).toContain("실행 중");
  });

  it("redacts secrets in captured output", async () => {
    const run = runner("key=AKIAIOSFODNN7EXAMPLE");
    const out = await runInTerminalTool({ command: "env" }, run);
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("returns an error for an empty command without running", async () => {
    const run = vi.fn();
    const out = await runInTerminalTool({ command: "   " }, run as never);
    expect(out).toContain("명령");
    expect(run).not.toHaveBeenCalled();
  });

  it("propagates errors when the session cannot accept input", async () => {
    await expect(
      runInTerminalTool({ command: "ls" }, async () => {
        throw new Error("연결된 터미널 세션이 없어 명령을 입력할 수 없습니다.");
      }),
    ).rejects.toThrow("연결된 터미널");
  });
});
