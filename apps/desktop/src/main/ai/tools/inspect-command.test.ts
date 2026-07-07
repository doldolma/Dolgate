import { describe, expect, it } from "vitest";
import { inspectCommandTool, type HostCommandResult } from "./inspect-command";

function exec(result: Partial<HostCommandResult>): (command: string) => Promise<HostCommandResult> {
  return async () => ({ stdout: "", stderr: "", exitCode: 0, truncated: false, ...result });
}

describe("inspectCommandTool", () => {
  it("formats stdout, stderr and exit code", async () => {
    const out = await inspectCommandTool(
      { command: "ls /etc" },
      exec({ stdout: "passwd\nhosts\n", exitCode: 0 }),
    );
    expect(out).toContain("$ ls /etc");
    expect(out).toContain("exit code: 0");
    expect(out).toContain("passwd");
  });

  it("surfaces a non-zero exit code and stderr", async () => {
    const out = await inspectCommandTool(
      { command: "cat /nope" },
      exec({ stderr: "No such file\n", exitCode: 1 }),
    );
    expect(out).toContain("exit code: 1");
    expect(out).toContain("No such file");
  });

  it("redacts secrets in output before returning to the model", async () => {
    const out = await inspectCommandTool(
      { command: "env" },
      exec({ stdout: "AWS_KEY=AKIAIOSFODNN7EXAMPLE\nsk-abcdefghijklmnop\n" }),
    );
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).not.toContain("sk-abcdefghijklmnop");
  });

  it("notes host-side truncation", async () => {
    const out = await inspectCommandTool({ command: "cat big" }, exec({ stdout: "x", truncated: true }));
    expect(out).toContain("truncated");
  });

  it("returns an error for an empty command", async () => {
    const out = await inspectCommandTool({ command: "  " }, exec({}));
    expect(out).toContain("명령");
  });

  it("propagates exec errors (unsupported session)", async () => {
    await expect(
      inspectCommandTool({ command: "ls" }, async () => {
        throw new Error("이 세션 유형은 명령 실행을 지원하지 않습니다.");
      }),
    ).rejects.toThrow("지원하지 않습니다");
  });
});
