import { describe, expect, it } from "vitest";
import {
  classifyReconnect,
  isCoreExitedMessage,
  isRemoteScreenErrorFinal,
} from "./reconnect-classify";

describe("classifyReconnect", () => {
  // 거절·취소는 사용자의 결정이다. 자동으로 다시 붙으면 그 결정을 무시하는 셈이고, 실기기에서
  // 그랬다 — "ssh handshake failed" 가 transient 로 걸려서 거절한 직후 다시 물었다.
  it("treats a declined host key and cancelled prompts as permanent", () => {
    for (const message of [
      "ssh handshake failed: ssh: handshake failed: host key was not trusted",
      "keyboard-interactive challenge was cancelled: context canceled",
      "host key trust prompt was cancelled: context canceled",
      "keyboard-interactive challenge was cancelled: no answer came back in time",
    ]) {
      expect(classifyReconnect(message), message).toBe("permanent");
    }
  });

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

  // 윈도우의 OS 소켓은 winsock 문구로 끊긴다 — "connection reset/refused" 같은 표현이 없어
  // 리눅스·gvisor 패턴에 하나도 안 걸렸고, unknown 이면 자동 재연결이 아예 안 걸린다.
  it("treats winsock wording from Windows drops as transient", () => {
    for (const message of [
      "read tcp 10.0.0.5:51920->192.168.200.4:22: wsarecv: An existing connection was forcibly closed by the remote host.",
      "write tcp 10.0.0.5:51920->192.168.200.4:22: wsasend: An established connection was aborted by the software in your host machine.",
      "dial tcp 192.168.200.4:22: connectex: No connection could be made because the target machine actively refused it.",
      "dial tcp 192.168.200.4:22: connectex: A connection attempt failed because the connected party did not properly respond after a period of time, or established connection failed because connected host has failed to respond.",
      "dial tcp 192.168.200.4:22: connectex: A socket operation was attempted to an unreachable host.",
    ]) {
      expect(classifyReconnect(message)).toBe("transient");
    }
  });

  // 소켓 원인 판정은 shared-core 한 벌이 한다. 이 테스트는 그 위임이 살아 있는지를 본다 —
  // 목록을 각자 들고 있던 시절에 윈도우 문구 계통을 통째로 놓쳐서 자동 재연결이 안 걸렸다.
  it("delegates socket causes to the shared classifier", () => {
    for (const message of [
      "read tcp 10.0.0.5:51920->192.168.200.4:22: wsarecv: An existing connection was forcibly closed by the remote host.",
      "write tcp 10.0.0.5:22: broken pipe",
      "connect tcp 100.112.69.93:9989: connection was refused",
      "dial tcp 192.168.200.4:22: connect: connection refused",
    ]) {
      expect(classifyReconnect(message)).toBe("transient");
    }
    // 이름이 틀린 것은 다시 붙어도 같다 — 주소를 고치는 것이 할 일이라 재연결 대상이 아니다.
    expect(classifyReconnect("dial tcp: lookup nas.local: no such host")).toBe(
      "unknown",
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
