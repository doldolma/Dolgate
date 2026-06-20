import { describe, expect, it } from "vitest";
import { classifyReconnect, isCoreExitedMessage } from "./reconnect-classify";

describe("classifyReconnect", () => {
  it("treats network drops as transient", () => {
    expect(classifyReconnect("connection reset by peer")).toBe("transient");
    expect(classifyReconnect("ssh keepalive failed: EOF")).toBe("transient");
    expect(classifyReconnect("read: i/o timeout")).toBe("transient");
    expect(classifyReconnect("ssh handshake failed: broken pipe")).toBe(
      "transient",
    );
  });

  it("treats auth/host-key failures as permanent", () => {
    expect(classifyReconnect("ssh: unable to authenticate")).toBe("permanent");
    expect(classifyReconnect("host key mismatch")).toBe("permanent");
    expect(classifyReconnect("permission denied (publickey)")).toBe(
      "permanent",
    );
    expect(classifyReconnect("no matching host key type")).toBe("permanent");
  });

  it("treats ssh-core exit as transient (debounced upstream)", () => {
    expect(classifyReconnect("SSH core exited (code=1)")).toBe("transient");
    expect(isCoreExitedMessage("SSH core exited (code=1)")).toBe(true);
    expect(isCoreExitedMessage("connection reset")).toBe(false);
  });

  it("returns unknown for empty or unrecognized messages", () => {
    expect(classifyReconnect("")).toBe("unknown");
    expect(classifyReconnect("something weird happened")).toBe("unknown");
  });
});
