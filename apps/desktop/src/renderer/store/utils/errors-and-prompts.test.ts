import { describe, expect, it } from "vitest";
import {
  connectFailureCopy,
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

  // 윈도우의 OS 소켓 dial 은 winsock 오류를 FormatMessage 가 풀어 쓴 문장으로 온다 — 세 번째
  // 문구 계통이다. "connection refused" 같은 표현이 한 번도 등장하지 않아 리눅스·gvisor 패턴에
  // 하나도 걸리지 않고, 놓치면 unknown 으로 떨어져 영어 원문이 다이얼로그에 그대로 떴다.
  // (포트를 옮긴 sshd 에 예전 포트로 붙었을 때 실제로 본 문구다.)
  it("presents winsock wording from Windows dials", () => {
    expect(
      resolveConnectionFailurePresentation(
        "dial failed: dial tcp 192.168.200.4:22: connectex: No connection could be made because the target machine actively refused it.",
      ),
    ).toEqual({
      title: "Connection Failed",
      message: "192.168.200.4:22에서 연결을 거부했습니다.",
    });
    expect(
      resolveConnectionFailurePresentation(
        "dial failed: dial tcp 192.168.200.4:22: connectex: A connection attempt failed because the connected party did not properly respond after a period of time, or established connection failed because connected host has failed to respond.",
      ).message,
    ).toBe("192.168.200.4:22 연결 시간이 초과되었습니다.");
    expect(
      resolveConnectionFailurePresentation(
        "dial failed: dial tcp 192.168.200.4:22: connectex: A socket operation was attempted to an unreachable host.",
      ).message,
    ).toBe(
      "192.168.200.4:22에 연결할 수 없습니다. 현재 네트워크에서 해당 호스트로 가는 경로가 없습니다.",
    );
    expect(
      resolveConnectionFailurePresentation(
        "read tcp 10.0.0.5:51920->192.168.200.4:22: wsarecv: An existing connection was forcibly closed by the remote host.",
      ).message,
    ).toBe("192.168.200.4:22 연결이 중간에 끊겼습니다.");
    expect(
      resolveConnectionFailurePresentation(
        "write tcp 10.0.0.5:51920->192.168.200.4:22: wsasend: An established connection was aborted by the software in your host machine.",
      ).message,
    ).toBe("192.168.200.4:22 연결이 중간에 끊겼습니다.");
  });

  // 코어가 OS 문구를 정경 문구로 접어 올린다(ssh-core 의 internal/neterr, 두 Rust 코어의
  // core_framing::neterr). 그 결과 문장은 "connection refused: <원문>" 꼴이 되는데, 접두사가
  // 붙었다고 더 구체적인 판정을 잃으면 안 된다 — tailnet·취소 규칙이 여전히 이긴다.
  it("reads core-normalized wording without losing the more specific verdict", () => {
    expect(
      resolveConnectionFailurePresentation(
        "connection refused: dial failed: dial tcp 192.168.200.4:22: connectex: No connection could be made because the target machine actively refused it.",
      ).message,
    ).toBe("192.168.200.4:22에서 연결을 거부했습니다.");
    // 코어가 socket 원인을 붙였어도 tailnet 이 알려 준 원인이 더 확실하다.
    const tailnet = resolveConnectionFailurePresentation(
      "connection refused: dial failed: this tailnet is not connected yet",
    );
    expect(tailnet.kind).toBe("tailscale-auth");
    expect(tailnet.layer).toBe("tailscale");
    // 사용자가 답을 안 한 것은 타임아웃이 아니다 — 다시 시도해도, 자격증명을 다시 넣어도 같다.
    expect(
      resolveConnectionFailurePresentation(
        "i/o timeout: begin connection: no answer came back in time",
      ).message,
    ).not.toContain("시간이 초과");
  });

  // SFTP 패널이 IPC 거절을 그대로 보여 주던 자리. 접두사("Error invoking remote method …")와
  // Go 문장이 사용자에게 노출됐고, tailnet 경유 실패는 gvisor 가 "connect tcp" 라고 써서 주소도
  // 못 읽혔다 — 실제로 본 문장이다.
  it("presents a tailnet-routed sftp refusal with the address", () => {
    expect(
      resolveConnectionFailurePresentation(
        "Error invoking remote method 'sftp:connect': Error: connection refused: tailnet 경유 연결 실패: connect tcp 100.75.145.89:22: connection was refused",
      ),
    ).toEqual({
      title: "Connection Failed",
      message: "100.75.145.89:22에서 연결을 거부했습니다.",
    });
  });

  // 코어는 문구와 함께 **원인 코드**도 올린다(ErrorPayload.failure). 문구를 처음 보는 경우에도
  // 원인을 알 수 있어야 하기 때문이다 — Rust 코어(RDP·VNC)는 OS 문구를 영어로 강제하지 않아서
  // 한국어 윈도우에서는 이런 문장이 올라온다.
  it("falls back to the cause code when the wording is unfamiliar", () => {
    expect(
      resolveConnectionFailurePresentation(
        "connect: TCP connect: 대상 컴퓨터에서 연결을 거부했으므로 연결하지 못했습니다. (os error 10061)",
        { failure: "refused" },
      ).message,
    ).toBe("대상 호스트에서 연결을 거부했습니다.");
    // 코드가 없으면 예전처럼 원문을 남긴다 — 뭉뚱그린 문구로 덮으면 단서가 사라진다.
    expect(
      resolveConnectionFailurePresentation(
        "connect: TCP connect: 대상 컴퓨터에서 연결을 거부했으므로 연결하지 못했습니다. (os error 10061)",
      ).message,
    ).toContain("os error 10061");
  });

  // **문구가 코드보다 먼저다.** 코어가 싣는 코드는 소켓 계층의 원인이고, 문장에는 그보다 구체적인
  // 원인이 들어 있을 수 있다 — 그것을 "연결이 거부됐습니다" 로 덮으면 할 일이 사라진다.
  it("keeps the more specific verdict when a cause code disagrees", () => {
    const tailnet = resolveConnectionFailurePresentation(
      "dial failed: this tailnet is not connected yet",
      { failure: "refused" },
    );
    expect(tailnet.kind).toBe("tailscale-auth");
    const hostKey = resolveConnectionFailurePresentation(
      "host key is not trusted yet",
      { failure: "reset" },
    );
    expect(hostKey.title).toBe("Host Key Not Trusted");
  });

  // 모르는 코드는 쓰지 않는다 — 새 코어가 우리가 모르는 코드를 실어 보내도 추측하지 않는다.
  it("ignores a cause code it does not know", () => {
    expect(
      resolveConnectionFailurePresentation("무슨 일이 났는지 모르는 문장", {
        failure: "quantum-collapse",
      }).message,
    ).toBe("무슨 일이 났는지 모르는 문장");
  });

  // 이름을 못 찾은 것은 경로가 없는 것과 할 일이 다르다 — 주소·DNS 를 봐야 한다.
  it("tells an unresolved name apart from an unreachable host", () => {
    expect(
      resolveConnectionFailurePresentation(
        "dial failed: dial tcp: lookup nas.local: no such host",
      ).message,
    ).toContain("주소를 찾을 수 없습니다");
    expect(
      resolveConnectionFailurePresentation(
        "dial failed: dial tcp 192.168.200.4:22: connectex: No such host is known.",
      ).message,
    ).toContain("주소를 찾을 수 없습니다");
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

  // VNC 인증 실패는 **코드로만** 판정된다. 서버가 붙이는 거부 사유는 서버가 정하는 문장이라
  // (RFB 는 형식을 정하지 않았다) 문구 규칙으로 가를 수 없다 — vnc-core 가 프로토콜에서 읽어
  // 코드로 올려 준다(services/vnc-core/src/failure.rs).
  it("presents VNC credential failures from the cause code", () => {
    const rejected = resolveConnectionFailurePresentation(
      "the server rejected the credentials: authentication failed",
      { failure: "auth-rejected" },
    );
    expect(rejected.title).toBe("Authentication Failed");
    expect(rejected.message).toBe("계정 또는 비밀번호를 확인하세요.");

    // 8자 절단은 갈 길이 다르다 — 비밀번호를 줄여야 한다.
    expect(
      resolveConnectionFailurePresentation("…", { failure: "password-truncated" }).message,
    ).toContain("8자");

    // 계정 기반 인증(ARD)이 거부됐고 같은 서버가 VNC 암호도 받는 경우. 계정을 비우라고
    // 말해 주지 않으면 사용자는 같은 비밀번호를 계속 넣는다.
    expect(
      resolveConnectionFailurePresentation("…", { failure: "account-auth-rejected" }).message,
    ).toContain("계정을 비워");

    // 없는 것을 채우라는 두 갈래.
    expect(
      resolveConnectionFailurePresentation("…", { failure: "password-required" }).title,
    ).toBe("Password Required");
    expect(
      resolveConnectionFailurePresentation("…", { failure: "account-required" }).title,
    ).toBe("Account Required");
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

  // 권한 부족은 다시 로그인해도 풀리지 않는다 — 고칠 곳은 정책이다. 예전에는 이 실패가
  // 분류되지 않아 AWS 영어 원문(ARN 한 줄)이 그대로 화면에 떴다.
  it("presents AWS permission denials with the denied IAM action", () => {
    expect(
      resolveConnectionFailurePresentation(
        "User: arn:aws:sts::123456789012:assumed-role/DevRole/dolma is not authorized to perform: ssm:StartSession on resource: arn:aws:ec2:ap-northeast-2:123456789012:instance/i-0abc",
      ),
    ).toEqual({
      title: "AWS Permission Required",
      message:
        "AWS가 ssm:StartSession 요청을 거부했습니다. 이 프로필의 IAM 사용자/역할에 그 권한이 있는지 확인해 주세요.",
    });
  });

  it("presents AWS permission denials without an action name as policy guidance", () => {
    expect(
      resolveConnectionFailurePresentation("UnauthorizedOperation"),
    ).toEqual({
      title: "AWS Permission Required",
      message:
        "AWS 권한이 없어 요청이 거부되었습니다. 이 프로필의 IAM 사용자/역할 정책을 확인해 주세요.",
    });
  });

  // 만료는 다시 로그인이 답이라 권한 문제와 섞으면 안 된다 — 만료된 토큰을 AccessDenied 로
  // 돌려주는 응답이 있어서 순서가 중요하다.
  it("keeps expired-credential failures on the sign-in path", () => {
    expect(
      resolveConnectionFailurePresentation(
        "AccessDeniedException: The security token included in the request is invalid",
      ),
    ).toEqual({
      title: "AWS Authentication Required",
      message: "AWS 인증을 확인하지 못했습니다. 다시 로그인해 주세요.",
    });
  });

  // SSH 의 "permission denied" 는 IAM 이 아니라 계정 인증 실패다 — 정책을 고치라고 말하면
  // 엉뚱한 곳을 뒤지게 된다.
  it("does not treat SSH permission denied as an IAM problem", () => {
    expect(
      resolveConnectionFailurePresentation(
        "ssh handshake failed: permission denied (publickey)",
      ).title,
    ).toBe("Connection Failed");
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

// invoke 경로(IPC 거절)의 연결 실패를 담을 자리가 연결 실패만 담는 필드가 아닐 때 쓰는 헬퍼.
// SFTP 패널이 그런 자리다 — 이름이 곧 "여기서 접는다" 는 규칙이다.
describe("connectFailureCopy", () => {
  it("folds an IPC rejection into user-facing copy", () => {
    expect(
      connectFailureCopy(
        new Error(
          "Error invoking remote method 'sftp:connect': Error: connection refused: tailnet 경유 연결 실패: connect tcp 100.75.145.89:22: connection was refused",
        ),
      ),
    ).toBe("100.75.145.89:22에서 연결을 거부했습니다.");
  });

  it("takes a plain string and a core cause code too", () => {
    expect(
      connectFailureCopy(
        "connect: TCP connect: 대상 컴퓨터에서 연결을 거부했으므로 연결하지 못했습니다. (os error 10061)",
        { failure: "refused" },
      ),
    ).toBe("대상 호스트에서 연결을 거부했습니다.");
  });

  // 분류할 수 없는 실패는 원문을 남긴다 — 뭉뚱그린 문구로 덮으면 단서가 사라진다.
  it("leaves an unclassified failure as its own sentence", () => {
    expect(connectFailureCopy(new Error("sftp: 무슨 일인지 모를 실패"))).toBe(
      "sftp: 무슨 일인지 모를 실패",
    );
    expect(connectFailureCopy(undefined)).toBe("연결을 완료하지 못했습니다.");
  });
});
