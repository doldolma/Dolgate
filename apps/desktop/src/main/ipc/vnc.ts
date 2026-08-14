import {
  isSshHostRecord,
  isVncHostRecord,
  type SshHostRecord,
  type VncInputEvent,
} from "@shared";
import { clipboard, ipcMain } from "electron";

import { ipcChannels } from "../../common/ipc-channels";
import { t } from "../i18n";
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
    // 여기서부터 통로를 여는 데 시간이 걸린다 — tailnet 을 쓰는 경유 호스트면 노드를 세우고
    // 로그인까지 기다린다. 말하지 않으면 화면은 그냥 멈춘 것으로 보인다.
    vncManager.reportProgress(
      sessionId,
      "ssh-tunnel-gateway",
      t("vnc.progress.tunnelGateway", {
        label: sshHost.label?.trim() || sshHost.hostname,
      }),
    );
    const trustedHostKeysBase64 = ctx.resolveTrustedHostKeys(sshHost);
    const username = ctx.requireConfiguredSshUsername(sshHost);
    const { secrets } = await ctx.resolveRuntimeSshSecrets(sshHost);
    await ctx.ensureCertificateAuthReady(sshHost, secrets);
    const jump = await ctx.resolveJumpHostTarget(sshHost);
    const authAgentEndpoint =
      sshHost.authType === "agent" ? await resolveLocalAgentEndpoint() : null;

    // bindPort 0 = 빈 포트를 OS 가 고른다. 고정 포트면 같은 대상에 두 번 붙을 때 충돌한다.
    //
    // `vnc:<sessionId>` 형식은 **화면과의 약속**이다. 코어가 이 터널에 대해 올리는 질문(OTP·호스트
    // 키)은 이 규칙 ID 를 상관 값으로 달고 오는데, 사용자가 만든 포워딩 규칙이 아니라서 화면의 규칙
    // 목록에는 없다. 렌더러는 이 접두어에서 세션을 되꺼내 그 VNC 탭 위에 입력창을 띄운다
    // (`store/utils/vnc.ts` 의 resolveVncTunnelSessionId). 형식을 바꾸면 그쪽도 같이 바꿔야 한다 —
    // 안 그러면 OTP 창이 다시 사라진다.
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
    // 통로가 열렸다. 이 다음의 실패는 원격 VNC 쪽이라는 뜻이고, 그 구분이 이 줄의 값이다.
    vncManager.reportProgress(
      sessionId,
      "ssh-tunnel-open",
      t("vnc.progress.tunnelOpen", {
        target: `${host.hostname}:${host.port}`,
      }),
    );
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
        // 통로가 정해졌으니 이제 RFB 협상이다. 경유가 없으면 이것이 유일한 진행 보고다.
        vncManager.reportProgress(
          sessionId,
          "connecting",
          t("vnc.progress.handshake", {
            target: `${host.hostname}:${host.port}`,
          }),
        );
        return await vncManager.connect(
          {
            sessionId,
            host: forwarded?.host ?? host.hostname,
            port: forwarded?.port ?? host.port,
            password: secrets.password,
            // 자격증명에 계정이 있으면 넘긴다. 쓸지 말지는 코어가 협상 결과로 판단한다 —
            // VncAuth 는 계정을 쓰지 않고, Plain 계열만 쓴다.
            username: secrets.username,
            // 화질. 없으면 무손실이다 — 코어가 모르는 값도 무손실로 떨어뜨린다.
            imageQuality: host.imageQuality ?? undefined,
            shared: host.shared !== false,
          },
          // 세션 lifecycle 로그(연결·종료·시간)용 호스트 정체. RDP·SSH 와 같은
          // `호스트 · 포트 · 사용자` 형식을 쓴다 — 계정은 자격증명에만 있고 대개 비어 있다.
          {
            hostId: host.id,
            hostLabel: host.label,
            title: host.label,
            connectionDetails: `${host.hostname} · ${host.port}${
              secrets.username?.trim() ? ` · ${secrets.username.trim()}` : ""
            }`,
          },
        );
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

  // 원격에서 복사된 텍스트를 로컬 클립보드에 넣는다. 클립보드는 메인 프로세스가 소유한다.
  vncManager.onRemoteClipboardText = (text) => {
    // 같은 값을 다시 쓰면 우리가 포커스 때 그것을 또 원격으로 올려 한 바퀴 돈다.
    if (clipboard.readText() !== text) {
      clipboard.writeText(text);
    }
  };

  // 원격 화면에 포커스가 갈 때 로컬 클립보드를 밀어 넣는다.
  //
  // 붙여넣는 순간에 읽을 수는 없다 — 키를 원격으로 보내려면 keydown 에서 preventDefault 를 해야
  // 하고 그러면 브라우저가 paste 이벤트를 만들지 않는다(RDP 와 같은 제약, useRdpClipboard 참고).
  ipcMain.on(ipcChannels.vnc.syncClipboard, (_event, sessionId: string) => {
    const text = clipboard.readText();
    if (text) {
      vncManager.sendClipboardText(sessionId, text);
    }
  });

  ipcMain.on(
    ipcChannels.vnc.setDesktopSize,
    (_event, sessionId: string, width: number, height: number) => {
      vncManager.requestDesktopSize(sessionId, width, height);
    },
  );

  ipcMain.on(ipcChannels.vnc.refresh, (_event, sessionId: string) => {
    vncManager.refreshScreen(sessionId);
  });

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
