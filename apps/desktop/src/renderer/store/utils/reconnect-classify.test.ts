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

  // tailnet 경유 세션은 gvisor netstack 문구로 끊긴다 — 여기서 놓치면 unknown 으로 떨어져
  // 재연결을 몇 번만 시도하고 포기한다.
  it("treats netstack wording from tailnet-routed drops as transient", () => {
    expect(classifyReconnect("connect tcp 100.112.69.93:9989: connection was refused")).toBe(
      "transient",
    );
    expect(classifyReconnect("dial tcp 100.64.0.2:22: host is down")).toBe("transient");
    expect(classifyReconnect("dial tcp 100.64.0.2:22: machine is not on the network")).toBe(
      "transient",
    );
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
