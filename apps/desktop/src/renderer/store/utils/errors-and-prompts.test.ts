import { describe, expect, it } from "vitest";
import {
  normalizeRemoteInvokeErrorMessage,
  resolveConnectionFailurePresentation,
} from "./errors-and-prompts";

describe("normalizeRemoteInvokeErrorMessage", () => {
  it("removes Electron IPC and Error prefixes", () => {
    expect(
      normalizeRemoteInvokeErrorMessage(
        "Error invoking remote method 'known-hosts:probe-host': Error: dial failed",
      ),
    ).toBe("dial failed");
  });
});

describe("resolveConnectionFailurePresentation", () => {
  it("presents AWS SSM session exit codes with concise copy", () => {
    expect(
      resolveConnectionFailurePresentation(
        "AWS SSM session exited with code 254",
      ),
    ).toEqual({
      title: "Connection Failed",
      message: "AWS SSM 세션이 종료되었습니다. (code 254)",
    });
  });

  it("presents network unreachable errors without raw Go wording", () => {
    expect(
      resolveConnectionFailurePresentation(
        "Error invoking remote method 'known-hosts:probe-host': Error: dial failed: dial tcp 192.168.1.201:22: connect: network is unreachable",
      ),
    ).toEqual({
      title: "Connection Failed",
      message:
        "192.168.1.201:22에 연결할 수 없습니다. 현재 네트워크에서 해당 호스트로 가는 경로가 없습니다.",
    });
  });

  it("presents connection refused errors without raw Go wording", () => {
    expect(
      resolveConnectionFailurePresentation(
        "dial failed: dial tcp 127.0.0.1:60050: connect: connection refused",
      ).message,
    ).toBe("127.0.0.1:60050에서 연결을 거부했습니다.");
  });

  it("presents timeout errors without raw Go wording", () => {
    expect(
      resolveConnectionFailurePresentation(
        "dial failed: dial tcp 10.0.0.10:22: i/o timeout",
      ).message,
    ).toBe("10.0.0.10:22 연결 시간이 초과되었습니다.");
  });

  it("presents EOF errors as interrupted connections", () => {
    expect(resolveConnectionFailurePresentation("ssh handshake failed: EOF")).toEqual({
      title: "Connection Failed",
      message: "대상 호스트 연결이 중간에 끊겼습니다.",
    });
  });

  it("presents untrusted host keys with the existing host-key guidance", () => {
    expect(resolveConnectionFailurePresentation("Host key is not trusted yet.")).toEqual({
      title: "Host Key Not Trusted",
      message:
        "이 호스트의 SSH 호스트 키를 먼저 신뢰해야 컨테이너를 조회할 수 있습니다.",
    });
  });

  it("falls back to the normalized raw message for unknown errors", () => {
    expect(
      resolveConnectionFailurePresentation(
        "Error invoking remote method 'containers:list': Error: something odd happened",
      ),
    ).toEqual({
      title: "Connection Failed",
      message: "something odd happened",
    });
  });
});
