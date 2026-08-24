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

  // tailnet 을 경유한 dial 은 OS 소켓이 아니라 tsnet 의 사용자 공간 스택(gvisor netstack)을
  // 지나므로 문구가 다르다 — "connection was refused". "was" 하나 때문에 예전 패턴이 통째로
  // 새어 나가 원문이 화면에 그대로 떴다.
  it("presents netstack wording from tailnet-routed dials", () => {
    expect(
      resolveConnectionFailurePresentation(
        'host-key probe failed for "test-mosh" [ubuntu:9989]: connect tcp 100.112.69.93:9989: connection was refused',
      ).message,
    ).not.toContain("connection was refused");
    expect(
      resolveConnectionFailurePresentation(
        "dial tcp 100.64.0.2:22: connection aborted",
      ).message,
    ).not.toContain("connection aborted");
    expect(
      resolveConnectionFailurePresentation(
        "dial tcp 100.64.0.2:22: host is down",
      ).message,
    ).not.toContain("host is down");
  });

  // rdp-core 의 문장이 "timed out waiting for the certificate decision" 이라, timeout 규칙에
  // 먼저 걸리면 "호스트가 응답하지 않는다" 로 뒤바뀐다 — 사용자가 할 일은 인증서 승인이라
  // 안내가 정반대가 된다. 그래서 인증서 규칙이 timeout 보다 앞이어야 한다.
  it("keeps an unanswered certificate prompt out of the timeout bucket", () => {
    const presented = resolveConnectionFailurePresentation(
      "begin connection: timed out waiting for the certificate decision",
    );
    expect(presented.message).not.toContain("시간이 초과");
    expect(presented.message).toContain("인증서");
    expect(presented.layer).toBe("hostKey");
  });

  it("presents a declined server certificate without the core wording", () => {
    const presented = resolveConnectionFailurePresentation(
      "begin connection: server certificate was not trusted",
    );
    expect(presented.message).not.toContain("certificate was not trusted");
    expect(presented.message).toContain("인증서");
    expect(presented.layer).toBe("hostKey");
  });

  it("presents timeout errors without raw Go wording", () => {
    expect(
      resolveConnectionFailurePresentation(
        "dial failed: dial tcp 10.0.0.10:22: i/o timeout",
      ).message,
    ).toBe("10.0.0.10:22 연결 시간이 초과되었습니다.");
  });

  it("keeps the server notice verbatim instead of collapsing it into a timeout", () => {
    // 터미널이 없는 경로(SFTP·포트포워딩·컨테이너)는 이 문구가 배너를 받는 유일한 수단이다.
    // 내용을 해석하지 않고 원문을 그대로 싣는지 본다 — 승인 주소인지 정책 안내인지는 사용자가
    // 읽고 판단할 몫이다.
    const presentation = resolveConnectionFailurePresentation(
      "ssh handshake failed: read tcp 10.0.0.10:22: i/o timeout" +
        " — 인증 단계에서 서버 응답이 없습니다. 서버가 보낸 안내:\n" +
        "# Tailscale SSH requires an additional check.\n" +
        "# To authenticate, visit: https://login.tailscale.com/a/le7a9c3c3519ae",
    );

    expect(presentation.message).toContain(
      "https://login.tailscale.com/a/le7a9c3c3519ae",
    );
    // 분류된 문구는 그대로 살린다 — 배너는 덧붙는 것이고 대체하는 것이 아니다.
    expect(presentation.message).toContain("연결 시간이 초과");
  });

  it("does not repeat the server notice on unclassified failures", () => {
    // 분류가 안 되는 실패는 원문을 그대로 문구로 쓴다. 안내를 떼어 두지 않으면 같은 글이 두 번 나온다.
    const presentation = resolveConnectionFailurePresentation(
      "something odd happened 서버가 보낸 안내:\n# please read https://example.test/policy",
    );

    const occurrences = presentation.message.split(
      "https://example.test/policy",
    ).length - 1;
    expect(occurrences).toBe(1);
  });

  it("adds no notice wording when the server sent none", () => {
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

  // 거절은 "아직 신뢰하지 않음" 과 다른 사건이다 — 사용자가 방금 결정한 것이고, 할 일은
  // "신뢰한 뒤 다시 시도" 가 아니라 다시 연결할지 결정하는 것뿐이다.
  it("presents a declined host key as the user's own decision", () => {
    expect(
      resolveConnectionFailurePresentation(
        "ssh handshake failed: ssh: handshake failed: host key was not trusted",
      ),
    ).toEqual({
      title: "Host Key Declined",
      message:
        "호스트 키를 신뢰하지 않아 연결을 끝냈습니다. 다시 연결하면 그 키를 또 물어봅니다.",
      layer: "hostKey",
    });
  });

  it("presents cancelled prompts as a cancellation, not a failure of the server", () => {
    expect(
      resolveConnectionFailurePresentation(
        "ssh handshake failed: ssh: handshake failed: keyboard-interactive challenge was cancelled: context canceled",
      ),
    ).toEqual({
      title: "Connection Failed",
      message: "연결을 그만뒀습니다. 다시 시도하려면 재시도를 누르세요.",
    });
  });

  it("presents untrusted host keys with the existing host-key guidance", () => {
    expect(resolveConnectionFailurePresentation("Host key is not trusted yet.")).toEqual({
      title: "Host Key Not Trusted",
      message:
        "이 호스트의 SSH 호스트 키를 아직 신뢰하지 않았습니다. 호스트 키를 신뢰한 뒤 다시 시도해 주세요.",
      // 실패를 분류하는 자리는 하나여야 한다 — 화면이 문구를 다시 뒤져 계층을 추측하면 같은
      // 판단이 두 곳에 생긴다. 이 계층 표시로 실패가 그 단계에 붙는다.
      layer: "hostKey",
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
