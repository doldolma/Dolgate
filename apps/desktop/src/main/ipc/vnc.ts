import {
  isSshHostRecord,
  isVncCredentialFailure,
  isVncHostRecord,
  type ConnectAttemptSecrets,
  type SshHostRecord,
  type VncConnectedPayload,
  type VncInputEvent,
} from "@shared";
import { clipboard, ipcMain } from "electron";

import { ipcChannels } from "../../common/ipc-channels";
import { t } from "../i18n";
import { resolveLocalAgentEndpoint } from "./agent-endpoint";
import {
  collectHopSecretsToPersist,
  credentialsNeededAfterFailure,
  CredentialsNeededError,
  findHostNeedingPassword,
  persistAttemptSecrets,
} from "./connect-credentials";
import { VncConnectError, type VncManager } from "../vnc-manager";
import type { MainIpcContext } from "./context";
import { hostPresenceGuard } from "./host-presence";

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
    host: ReturnType<typeof ctx.vaults.getHost> & { kind: "vnc" },
    /** 요청 창에 넣은 SSH 터널 호스트(대상)와 그 점프의 값. */
    attempt?: ConnectAttemptSecrets,
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

    const jumpTarget = ctx.vaults.getHost(tunnelHostId);
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
    const auth = await ctx.resolveSshAuth(sshHost, attempt?.secrets);
    const { username, authType, secrets } = auth;
    await ctx.ensureCertificateAuthReady(sshHost, secrets, authType);
    const jump = await ctx.resolveJumpHostTarget(sshHost, attempt?.jumpSecrets);
    const hopSecretsToPersist = await collectHopSecretsToPersist(ctx, sshHost, attempt?.jumpSecrets);
    const authAgentEndpoint =
      authType === "agent" ? await resolveLocalAgentEndpoint() : null;

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
      authType,
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
    }).catch((error: unknown) => {
      // 터널 호스트나 그 점프가 넣은 값을 거절했으면 요청 창이 그 홉을 다시 묻게 한다(connect 가 결과로 바꾼다).
      const needed = credentialsNeededAfterFailure(ctx, sshHost, error);
      throw needed ? new CredentialsNeededError(needed) : error;
    });
    forwardBySession.set(sessionId, { kind: "ssh", ruleId });
    // 코어는 SSH 인증을 마친 뒤에 '시작됨'을 알린다 — 이제 넣은 값을 제자리에(팀 호스트는 내 자격 증명). 통로를 먼저
    // 적어 둔다 — 저장이 실패해도 그 통로는 닫을 수 있어야 한다.
    await persistAttemptSecrets(ctx, sshHost, auth, hopSecretsToPersist);
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
    async (event, sessionId: string, hostId: string, attempt?: ConnectAttemptSecrets) => {
      const host = ctx.vaults.getHost(hostId);
      if (!host) {
        throw new Error("Host not found");
      }
      if (!isVncHostRecord(host)) {
        throw new Error("Not a VNC host");
      }

      // SSH 터널 호스트(또는 그 점프)에 쓸 비밀번호가 없으면 아무것도 열지 않고 그 홉을 알린다 — 화면이 요청 창을
      // 그 홉으로 띄운다. 코어에 맡기면 붙기 전에 영어 원문으로 멈추고, 그 문구는 VNC 비밀번호로 읽힌다.
      // openForward 와 같은 순서로 고른다 — tailnet 이 있으면 SSH 터널을 쓰지 않는다.
      const tunnelHostId = host.tailnetId?.trim() ? null : host.sshTunnelHostId?.trim();
      const tunnelHost = tunnelHostId ? ctx.vaults.getHost(tunnelHostId) : null;
      if (tunnelHost && isSshHostRecord(tunnelHost)) {
        const needsPasswordFor = await findHostNeedingPassword(ctx, tunnelHost, attempt?.secrets, attempt?.jumpSecrets);
        if (needsPasswordFor) {
          return { credentialsNeeded: { hostId: needsPasswordFor, reason: "missing" as const } };
        }
      }

      // 비밀값·통로를 기다리는 사이 팀에서 빠지면(지우면) 이 세션은 아직 VNC 관리자에 적히지 않아 닫기가 닿지 않는다 —
      // 기다림 뒤 손대기 전마다 본다.
      const ensureHostPresent = hostPresenceGuard(ctx, host.id);
      const secrets = await ctx.loadHostSecrets(host);
      ensureHostPresent();
      // 요청 창에 넣은 VNC 값이 저장된 것보다 먼저다. 계정이 실려 있으면 빈 값이라도 그것을 쓴다(계정을 비워 VNC 암호로 붙기).
      const typed = attempt?.vncSecrets;
      const password = typed?.password ?? secrets.password;
      const username = typed && typed.username !== undefined ? typed.username : secrets.username;
      // 프레임을 보낼 창을 먼저 등록한다. 접속이 끝난 뒤에 등록하면 첫 화면을 놓친다 — 서버는
      // 우리가 요청한 전체 갱신을 곧바로 보낸다.
      vncManager.watchSession(sessionId, event.sender.id);

      let forwarded: { host: string; port: number } | null = null;
      let connected: VncConnectedPayload;
      try {
        forwarded = await openForward(sessionId, host, attempt);
        // 통로가 열리는 사이 빠졌을 수 있다 — 붙지 않는다(아래에서 연 통로를 닫는다).
        ensureHostPresent();
        // 통로가 정해졌으니 이제 RFB 협상이다. 경유가 없으면 이것이 유일한 진행 보고다.
        vncManager.reportProgress(
          sessionId,
          "connecting",
          t("vnc.progress.handshake", {
            target: `${host.hostname}:${host.port}`,
          }),
        );
        // 이 창이 이 세션의 주인이다. 창이 닫히면 세션도 끊는다(아래 watch 의 destroyed 훅).
        vncManager.setSessionOwner(sessionId, event.sender.id);
        connected = await vncManager.connect(
          {
            sessionId,
            host: forwarded?.host ?? host.hostname,
            port: forwarded?.port ?? host.port,
            password,
            // 자격증명에 계정이 있으면 넘긴다. 쓸지 말지는 코어가 협상 결과로 판단한다 —
            // VncAuth 는 계정을 쓰지 않고, Plain 계열만 쓴다.
            username,
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
              username?.trim() ? ` · ${username.trim()}` : ""
            }`,
          },
        );
      } catch (error) {
        // 접속이 실패하면 열어 둔 통로를 닫는다. 안 닫으면 실패한 시도마다 리스너가 남는다.
        closeForward(sessionId);
        vncManager.unwatchSession(sessionId, event.sender.id);
        // 붙는 사이 호스트가 사라졌으면(팀에서 빠짐 — 팀 게이트웨이의 터널이 먼저 멈춘다) 터널이 남긴 취소 오류 대신 그 까닭으로
        // 끝낸다. 그대로 넘기면 탭에 '연결을 그만뒀습니다'가 보였다.
        ensureHostPresent();
        // 터널 호스트나 그 점프가 넣은 값을 거절했다 — 화면이 그 홉을 다시 묻는다.
        if (error instanceof CredentialsNeededError) {
          return { credentialsNeeded: error.needed };
        }
        // VNC 서버가 계정·비밀번호를 요구하거나 거절했다 — 화면이 이 호스트의 값을 요청 창으로 묻는다. 계정은 무엇을 썼는지
        // 함께 알린다(계정까지 묻는 창에 미리 채운다).
        if (error instanceof VncConnectError && isVncCredentialFailure(error.failure)) {
          const missing = error.failure === "password-required" || error.failure === "account-required";
          return {
            credentialsNeeded: {
              hostId: host.id,
              reason: missing ? ("missing" as const) : ("rejected" as const),
              message: error.message,
              failure: error.failure,
              ...(username?.trim() ? { username: username.trim() } : {}),
            },
          };
        }
        // 코어가 이 실패를 이미 화면에 알렸다(까닭 코드와 함께) — 탭은 그 알림이 그렸다. 오류로 던지면 화면 흐름이 그 표시
        // (Retry·재연결 예약)를 덮는다.
        if (error instanceof VncConnectError && error.reported) {
          return { failureReported: true as const };
        }
        throw error;
      }
      // 넣은 값으로 붙었다 — 쓴 계정·비밀번호를 제자리에 둔다(개인 호스트는 호스트 비밀값, 팀 호스트는 내 자격 증명). 다음부터는
      // 묻지 않는다. 저장이 실패해도 붙은 연결은 그대로 둔다 — 다음에 다시 물을 뿐이다.
      if (typed) {
        await ctx
          .persistHostSpecificSecret(host.id, host.label, {
            kind: "vnc",
            username: username?.trim() || undefined,
            password,
          })
          .catch((error: unknown) => {
            console.warn("[vnc] failed to save the entered credentials", error);
          });
      }
      return connected;
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
    // Electron 44 부터 클립보드 읽기·쓰기는 Promise 다 — await 가 빠지면 비교가 늘 참이 된다.
    void (async () => {
      if ((await clipboard.readText()) !== text) {
        await clipboard.writeText(text);
      }
    })().catch((error: unknown) => {
      console.warn("[vnc] failed to write remote clipboard text", error);
    });
  };

  // 원격 화면에 포커스가 갈 때 로컬 클립보드를 밀어 넣는다.
  //
  // 붙여넣는 순간에 읽을 수는 없다 — 키를 원격으로 보내려면 keydown 에서 preventDefault 를 해야
  // 하고 그러면 브라우저가 paste 이벤트를 만들지 않는다(RDP 와 같은 제약, useRdpClipboard 참고).
  ipcMain.on(ipcChannels.vnc.syncClipboard, (_event, sessionId: string) => {
    void clipboard
      .readText()
      .then((text) => {
        if (text) {
          vncManager.sendClipboardText(sessionId, text);
        }
      })
      .catch((error: unknown) => {
        console.warn("[vnc] failed to read local clipboard text", error);
      });
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

  // **창이 닫히면 등록을 지우고, 그 창이 주인인 세션은 끊는다.**
  //
  // 등록만 남으면 죽은 webContents id 가 watcher 집합에 쌓이고(RDP 쪽은 이 훅이 있었다), 세션을
  // 끊지 않으면 멀티윈도우에서 창 하나를 닫아도 그 창의 VNC 세션이 서버 쪽 화면까지 잡은 채로
  // 앱이 끝날 때까지 살아 있다.
  ipcMain.on(ipcChannels.vnc.watch, (event, sessionId: string) => {
    const id = event.sender.id;
    vncManager.watchSession(sessionId, id);
    event.sender.once("destroyed", () => {
      vncManager.forgetWatcher(id);
      vncManager.disconnectSessionsOwnedBy(id);
    });
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
