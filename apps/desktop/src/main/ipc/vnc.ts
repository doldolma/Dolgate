import {
  isSshHostRecord,
  isVncHostRecord,
  type SshHostRecord,
  type VncInputEvent,
} from "@shared";
import { ipcMain } from "electron";

import { ipcChannels } from "../../common/ipc-channels";
import { resolveLocalAgentEndpoint } from "./agent-endpoint";
import type { VncManager } from "../vnc-manager";
import type { MainIpcContext } from "./context";

// 렌더러는 hostId 만 넘긴다. 호스트 조회와 비밀번호 해석은 여기서 한다 — 자격증명은 메인 프로세스
// 밖으로 나가지 않는다(SSH·RDP 와 같은 규칙).

export function registerVncIpcHandlers(
  ctx: MainIpcContext,
  vncManager: VncManager,
): void {
  /**
   * 이 세션이 무엇을 거쳐 붙는지. 세션이 끝날 때 그 통로를 닫아야 하므로 기억해 둔다.
   *
   * vnc-core 는 tailnet 도 SSH 도 직접 쓸 수 없다. ssh-core 가 `127.0.0.1` 리스너를 열어 그쪽으로
   * 이어 주고, 코어는 그 주소로 평범하게 붙는다 — rdp-core 와 같은 방식이다.
   */
  const forwardBySession = new Map<
    string,
    { kind: "tailnet" } | { kind: "ssh"; ruleId: string }
  >();

  /**
   * 경유가 필요하면 로컬 포워드를 열고 그 주소를 돌려준다. 직접 붙으면 null.
   *
   * **VNC 에서 SSH 터널이 특히 중요하다.** QEMU·libvirt 콘솔은 5900 을 localhost 에만 바인딩하는
   * 것이 관행이라 그 경로가 아니면 아예 닿지 않는다.
   */
  const openForward = async (
    sessionId: string,
    host: ReturnType<typeof ctx.hosts.getById> & { kind: "vnc" },
  ): Promise<{ host: string; port: number } | null> => {
    const tailnetId = host.tailnetId?.trim();
    if (tailnetId) {
      const address = await ctx.coreManager.openTailnetForward({
        id: sessionId,
        tailnetId,
        host: host.hostname,
        port: host.port,
      });
      forwardBySession.set(sessionId, { kind: "tailnet" });
      return splitAddress(address, host.port);
    }

    const tunnelHostId = host.sshTunnelHostId?.trim();
    if (!tunnelHostId) {
      return null;
    }

    const jumpTarget = ctx.hosts.getById(tunnelHostId);
    if (!jumpTarget || !isSshHostRecord(jumpTarget)) {
      // 지웠거나 종류가 바뀐 호스트다. 조용히 직접 붙으면 "왜 안 되지" 가 되므로 이유를 말한다.
      throw new Error(
        "경유할 SSH 호스트를 찾을 수 없습니다. VNC 호스트 설정에서 다시 골라 주세요.",
      );
    }

    const sshHost = jumpTarget as SshHostRecord;
    const trustedHostKeysBase64 = ctx.requireTrustedHostKeys(sshHost);
    const username = ctx.requireConfiguredSshUsername(sshHost);
    const { secrets } = await ctx.resolveRuntimeSshSecrets(sshHost);
    await ctx.ensureCertificateAuthReady(sshHost, secrets);
    const jump = await ctx.resolveJumpHostTarget(sshHost);
    const authAgentEndpoint =
      sshHost.authType === "agent" ? await resolveLocalAgentEndpoint() : null;

    // bindPort 0 = 빈 포트를 OS 가 고른다. 고정 포트면 같은 대상에 두 번 붙을 때 충돌한다.
    const ruleId = `vnc:${sessionId}`;
    const runtime = await ctx.coreManager.startPortForward({
      ruleId,
      hostId: sshHost.id,
      host: sshHost.hostname,
      port: sshHost.port,
      username,
      authType: sshHost.authType,
      password: secrets.password,
      privateKeyPem: secrets.privateKeyPem,
      certificateText: secrets.certificateText,
      passphrase: secrets.passphrase,
      trustedHostKeyBase64: trustedHostKeysBase64[0],
      trustedHostKeysBase64,
      jump,
      // 셸과 같은 경로를 타야 한다. 안 넘기면 tailnet 호스트의 포워딩이 일반 네트워크로 나간다.
      ...ctx.resolveTailnetRoute(sshHost),
      authAgentEndpointKind: authAgentEndpoint?.kind,
      authAgentEndpoint: authAgentEndpoint?.endpoint,
      mode: "local",
      bindAddress: "127.0.0.1",
      bindPort: 0,
      // 경유 서버가 보는 대상이다. 대개 localhost 지만 호스트에 적힌 주소를 그대로 쓴다 —
      // 경유 서버에서 다른 기기의 5900 으로 이어 주는 구성도 있다.
      targetHost: host.hostname,
      targetPort: host.port,
    });
    forwardBySession.set(sessionId, { kind: "ssh", ruleId });
    return { host: runtime.bindAddress, port: runtime.bindPort };
  };

  const closeForward = (sessionId: string) => {
    const forward = forwardBySession.get(sessionId);
    if (!forward) {
      return;
    }
    forwardBySession.delete(sessionId);
    if (forward.kind === "tailnet") {
      ctx.coreManager.closeTailnetForward(sessionId);
      return;
    }
    // 실패해도 삼킨다 — 이미 죽은 터널을 닫는 것이 세션 정리를 막아서는 안 된다.
    void ctx.coreManager.stopPortForward(forward.ruleId).catch(() => undefined);
  };

  ipcMain.handle(
    ipcChannels.vnc.connect,
    async (event, sessionId: string, hostId: string) => {
      const host = ctx.hosts.getById(hostId);
      if (!host) {
        throw new Error("Host not found");
      }
      if (!isVncHostRecord(host)) {
        throw new Error("Not a VNC host");
      }

      const secrets = await ctx.loadSecrets(host.secretRef);
      // 프레임을 보낼 창을 먼저 등록한다. 접속이 끝난 뒤에 등록하면 첫 화면을 놓친다 — 서버는
      // 우리가 요청한 전체 갱신을 곧바로 보낸다.
      vncManager.watchSession(sessionId, event.sender.id);

      let forwarded: { host: string; port: number } | null = null;
      try {
        forwarded = await openForward(sessionId, host);
        return await vncManager.connect({
          sessionId,
          host: forwarded?.host ?? host.hostname,
          port: forwarded?.port ?? host.port,
          password: secrets.password,
          shared: host.shared !== false,
        });
      } catch (error) {
        // 접속이 실패하면 열어 둔 통로를 닫는다. 안 닫으면 실패한 시도마다 리스너가 남는다.
        closeForward(sessionId);
        vncManager.unwatchSession(sessionId, event.sender.id);
        throw error;
      }
    },
  );

  ipcMain.handle(ipcChannels.vnc.disconnect, (_event, sessionId: string) => {
    vncManager.disconnect(sessionId);
    closeForward(sessionId);
  });

  ipcMain.on(
    ipcChannels.vnc.input,
    (_event, sessionId: string, events: VncInputEvent[]) => {
      vncManager.sendInput(sessionId, events);
    },
  );

  ipcMain.on(ipcChannels.vnc.watch, (event, sessionId: string) => {
    vncManager.watchSession(sessionId, event.sender.id);
  });

  ipcMain.on(ipcChannels.vnc.unwatch, (event, sessionId: string) => {
    vncManager.unwatchSession(sessionId, event.sender.id);
  });

  ipcMain.handle(ipcChannels.vnc.describeSession, (_event, sessionId: string) =>
    vncManager.describeSession(sessionId),
  );

  return;
}

/**
 * `host:port` 문자열을 나눈다.
 *
 * tailnet 포워드는 문자열로 주소를 돌려준다. IPv6 리터럴이 올 수 있어 마지막 콜론에서 자른다 —
 * 앞에서 자르면 `[::1]:5900` 이 깨진다.
 */
function splitAddress(address: string, fallbackPort: number): { host: string; port: number } {
  const separator = address.lastIndexOf(":");
  if (separator <= 0) {
    return { host: address, port: fallbackPort };
  }
  const port = Number.parseInt(address.slice(separator + 1), 10);
  return {
    host: address.slice(0, separator),
    port: Number.isFinite(port) ? port : fallbackPort,
  };
}
