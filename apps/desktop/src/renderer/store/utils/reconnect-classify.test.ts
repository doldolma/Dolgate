import { describe, expect, it } from "vitest";
import {
  classifyReconnect,
  isCoreExitedMessage,
  isRemoteScreenErrorFinal,
} from "./reconnect-classify";

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

describe("isRemoteScreenErrorFinal", () => {
  it("RDP·VNC 의 인증·계정 문구를 영구로 본다", () => {
    // 반복하면 계정이 잠긴다. RDP 는 NTSTATUS 문자열, VNC 는 한국어 문구로 온다.
    expect(isRemoteScreenErrorFinal("STATUS_LOGON_FAILURE")).toBe(true);
    expect(isRemoteScreenErrorFinal("ACCOUNT_LOCKED")).toBe(true);
    expect(isRemoteScreenErrorFinal("비밀번호가 틀렸습니다")).toBe(true);
    expect(isRemoteScreenErrorFinal("서버가 인증을 거절했습니다")).toBe(true);
    expect(
      isRemoteScreenErrorFinal("Authentication or authorization failure"),
    ).toBe(true);
  });

  it("SSH 쪽 영구 오류도 그대로 영구다", () => {
    // VNC 는 SSH 터널을 거칠 수 있어 그쪽 문구가 그대로 올라온다.
    expect(isRemoteScreenErrorFinal("host key mismatch")).toBe(true);
    expect(isRemoteScreenErrorFinal("permission denied")).toBe(true);
  });

  // **거절·타임아웃은 영구가 아니다.** 붙어 있던 세션이 그 오류를 내면 서버가 재부팅 중이라는
  // 뜻이고 그때는 재시도가 맞다. 첫 연결의 포트 오타를 막는 것은 이 분류가 아니라 "붙어 본 적
  // 있는가" 게이트다(runtimeEventSlice 의 shouldAutoReconnectRemoteScreen).
  it("연결 거절·타임아웃은 영구로 보지 않는다", () => {
    expect(isRemoteScreenErrorFinal("connect: TCP connect: connection refused")).toBe(
      false,
    );
    expect(isRemoteScreenErrorFinal("connect: TCP connect: i/o timeout")).toBe(false);
    expect(isRemoteScreenErrorFinal("연결이 끊어졌습니다. (os error 10060)")).toBe(
      false,
    );
  });

  it("빈 문구는 영구가 아니다", () => {
    expect(isRemoteScreenErrorFinal("")).toBe(false);
    expect(isRemoteScreenErrorFinal(undefined)).toBe(false);
  });
});
