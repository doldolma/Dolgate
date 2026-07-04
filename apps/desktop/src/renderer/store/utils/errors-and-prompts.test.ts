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
        "이 호스트의 SSH 호스트 키를 아직 신뢰하지 않았습니다. 호스트 키를 신뢰한 뒤 다시 시도해 주세요.",
    });
  });

  it("presents AWS CLI SSO token failures as authentication guidance", () => {
    expect(
      resolveConnectionFailurePresentation(
        "aws: [ERROR]: Error when retrieving token from sso: Token has expired and refresh failed",
      ),
    ).toEqual({
      title: "AWS Authentication Required",
      message: "AWS 인증을 확인하지 못했습니다. 다시 로그인해 주세요.",
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

  it("names the failing host from an enriched host-key probe error (direct hop)", () => {
    expect(
      resolveConnectionFailurePresentation(
        `Error invoking remote method 'known-hosts:probe-host': Error: host-key probe failed for "Lime-GW" [183.99.29.89:2731]: host key probe failed: ssh: handshake failed: read tcp 192.168.0.70:56736->183.99.29.89:2731: read: connection reset by peer`,
      ),
    ).toEqual({
      title: "Connection Failed",
      message: "'Lime-GW' (183.99.29.89:2731) 연결이 중간에 끊겼습니다.",
    });
  });

  it("names the target and the failing bastion endpoint for a jump-routed probe", () => {
    expect(
      resolveConnectionFailurePresentation(
        `host-key probe failed for "lime-dev" [192.168.0.13:22] via-jump: dial through jump host: ssh: handshake failed: read tcp 10.0.0.2:51000->183.99.29.89:2731: read: connection reset by peer`,
      ).message,
    ).toBe(
      "'lime-dev' (192.168.0.13:22) · 점프 경유 183.99.29.89:2731 연결이 중간에 끊겼습니다.",
    );
  });

  it("extracts the remote endpoint from a raw read-tcp reset when unenriched", () => {
    expect(
      resolveConnectionFailurePresentation(
        "ssh: handshake failed: read tcp 192.168.0.70:56736->183.99.29.89:2731: read: connection reset by peer",
      ).message,
    ).toBe("183.99.29.89:2731 연결이 중간에 끊겼습니다.");
  });

  it("presents an empty ssh-agent as actionable guidance", () => {
    expect(
      resolveConnectionFailurePresentation(
        "ssh handshake failed: ssh-agent has no keys",
      ),
    ).toEqual({
      title: "Connection Failed",
      message:
        "SSH 에이전트에 등록된 키가 없습니다. 에이전트에 키를 추가한 뒤 다시 연결해 주세요.",
    });
  });

  it("presents an unreachable ssh-agent as actionable guidance", () => {
    expect(
      resolveConnectionFailurePresentation(
        "ssh-agent connection failed: dial unix /tmp/agent.sock: connect: no such file or directory",
      ).message,
    ).toBe("SSH 에이전트에 연결하지 못했습니다. 에이전트가 실행 중인지 확인해 주세요.");
  });
});
