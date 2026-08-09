import {
  isRdpHostRecord,
  type RdpCertificatePrompt,
  type RdpInputEvent,
  type RdpLocalMonitor,
  type RdpMonitorSelection,
  type RdpSessionEvent,
} from "@shared";
import type { WebContents } from "electron";
import { app, BrowserWindow, clipboard, dialog, ipcMain, screen } from "electron";
import { ipcChannels } from "../../common/ipc-channels";
import type { RdpManager } from "../rdp-manager";
import { decideCertificate } from "../rdp-certificate-trust";
import { resolveSelectedDisplays } from "../rdp-monitor-selection";
import { mapScreenPointToDesktop } from "../rdp-screen-pointer";
import { RdpMonitorWindows } from "../rdp-monitor-windows";
import type { MainIpcContext } from "./context";

// 렌더러는 hostId 만 넘긴다. 호스트 레코드 조회와 비밀번호 해석은 여기서 한다 —
// 자격증명은 메인 프로세스 밖으로 나가지 않는다(SSH/serial 과 같은 규칙).
export function registerRdpIpcHandlers(
  ctx: MainIpcContext,
  rdpManager: RdpManager,
  runtime: {
    /** 인증서 프롬프트를 띄우고 사용자의 판단을 기다린다. */
    askCertificate: (prompt: RdpCertificatePrompt) => Promise<boolean>;
  },
): void {
  // 어느 세션이 어느 호스트로 붙는 중인지. 인증서 판정은 connect 응답보다 먼저 오므로,
  // 호스트를 되찾으려면 여기 기록해 두어야 한다.
  const hostBySession = new Map<string, string>();

  rdpManager.setCertificateVerifier((sessionId, certificate) =>
    decideCertificate(
      {
        lookupHost: (id) => {
          const hostId = hostBySession.get(id);
          if (!hostId) {
            return null;
          }
          const host = ctx.hosts.getById(hostId);
          if (!host || !isRdpHostRecord(host)) {
            return null;
          }
          return {
            hostId: host.id,
            label: host.label,
            fingerprint: host.certificateFingerprint ?? null,
          };
        },
        ask: runtime.askCertificate,
        persist: (hostId, fingerprint) => {
          const host = ctx.hosts.getById(hostId);
          if (!host || !isRdpHostRecord(host)) {
            return;
          }
          ctx.hosts.updateRdpCertificateFingerprint(hostId, fingerprint);
          ctx.activityLogs.append("info", "audit", "RDP certificate trusted", {
            hostId,
            fingerprint,
          });
          // 이게 없으면 핀이 로컬에만 남는다. 다음 pull 이 호스트 목록을 서버 사본으로 통째로
          // 교체하면서(sync-service: state.data.hosts = hosts) 조용히 지워지고, 사용자는
          // 앱을 켤 때마다 같은 서버를 다시 신뢰하게 된다.
          ctx.queueSync();
        },
      },
      sessionId,
      certificate,
    ),
  );

  // 디스플레이 목록은 캐시한다.
  //
  // 마우스 이동마다 screen.getAllDisplays() 를 부르면 초당 100번 넘게 OS 를 조회하게 되어
  // 커서가 눈에 띄게 밀린다. 화면 구성이 바뀔 때만 다시 읽는다.
  let cachedDisplays: Electron.Display[] | null = null;
  const displays = () => {
    cachedDisplays ??= screen.getAllDisplays();
    return cachedDisplays;
  };
  const invalidateDisplays = () => {
    cachedDisplays = null;
  };
  screen.on("display-added", invalidateDisplays);
  screen.on("display-removed", invalidateDisplays);
  screen.on("display-metrics-changed", invalidateDisplays);

  // 세션마다 접속 때 선언한 로컬 디스플레이 순서. 원격 모니터 번호와 물리 화면을 잇는 유일한
  // 연결고리라, 이게 없으면 어느 화면에 무엇을 띄울지 알 수 없다.
  const displayIdsBySession = new Map<string, number[]>();
  const monitorWindows = new RdpMonitorWindows();

  ipcMain.handle(
    ipcChannels.rdp.spreadMonitors,
    async (event, sessionId: string): Promise<number | null> => {
      const window = BrowserWindow.fromWebContents(event.sender);
      const connected = rdpManager.describeSession(sessionId);
      const displayIds = displayIdsBySession.get(sessionId);
      if (!window || !connected || !displayIds) {
        return null;
      }

      const mainIndex = await monitorWindows.open(
        sessionId,
        window,
        connected.monitors,
        displayIds,
      );
      const region = mainIndex === null ? null : connected.monitors[mainIndex];
      // 메인 창은 자기 화면 몫만 그려야 한다. 안 알려주면 전체 데스크톱을 축소해 그린 채로
      // 남아, 보조 창들과 같은 내용이 겹쳐 보인다.
      rdpManager.emitMonitorRegion(sessionId, region ?? null);

      // 정리는 메인 프로세스가 책임진다. 렌더러가 접어 달라고 부르는 경로만 믿으면, 그 신호가
      // 안 오는 순간(전체화면을 다른 창에서 빠져나오거나, 창이 그냥 닫히거나, 렌더러가 죽거나)
      // 보조 창이 화면을 덮은 채 남는다. 프레임 없는 전체화면 창이라 사용자가 지우기도 어렵다.
      const collapse = () => {
        // 짝이 되는 리스너도 같이 뗀다. 펼치기/접기를 반복할 때마다 쌓이면 창 하나에 같은
        // 핸들러가 여러 개 붙는다.
        window.removeListener("leave-full-screen", collapse);
        window.removeListener("closed", collapse);
        void monitorWindows.close(sessionId);
        rdpManager.emitMonitorRegion(sessionId, null);
      };
      window.on("leave-full-screen", collapse);
      window.on("closed", collapse);

      return mainIndex;
    },
  );

  ipcMain.handle(
    ipcChannels.rdp.collapseMonitors,
    async (_event, sessionId: string) => {
      await monitorWindows.close(sessionId);
      rdpManager.emitMonitorRegion(sessionId, null);
    },
  );

  // 앱을 내릴 때도 남기지 않는다. 보조 창이 살아 있으면 창이 다 닫히지 않아 앱이 종료되지도
  // 않는다 — 사용자가 메인 창을 닫았는데 다른 화면에 전체화면 창만 남는 상태가 된다.
  app.on("before-quit", () => {
    void monitorWindows.closeAll();
  });

  ipcMain.handle(
    ipcChannels.rdp.connect,
    async (
      event,
      sessionId: string,
      hostId: string,
      viewport?: { width: number; height: number },
    ) => {
      const host = ctx.hosts.getById(hostId);
      if (!host) {
        throw new Error("Host not found");
      }
      if (!isRdpHostRecord(host)) {
        throw new Error("Not an RDP host");
      }

      // 시크릿을 읽기 전에 등록한다. await 뒤로 미루면 그 사이에 인증서 판정이 도착했을 때
      // 세션이 어느 호스트인지 몰라 저장된 핀을 못 찾고, 신뢰한 서버를 다시 묻게 된다.
      hostBySession.set(sessionId, hostId);
      const secrets = await ctx.loadSecrets(host.secretRef);

      // 여러 화면을 고른 경우에만 실제 배치를 빌려준다.
      //
      // 하나만 골랐다면 그건 "이 화면에 띄운다"가 아니라 "펼치지 않는다"는 뜻이다. 그 모니터의
      // 물리 해상도를 그대로 선언하면(3008x1692 같은) 창은 그보다 훨씬 작은데 프레임은 큰 화면
      // 기준으로 와서 낭비가 크다. 예전처럼 앱 해상도로 붙고 창 크기를 따라가게 둔다.
      const selected = host.monitors?.length
        ? describeLocalMonitors(host.monitors)
        : null;
      const layout =
        selected && selected.monitors.length > 1
          ? selected
          : {
              monitors: [
                {
                  // 창 크기로 붙는다. 호스트에 적어 둔 해상도로 붙으면 첫 화면이 창과 다른
                  // 크기로 와서, 창에 맞춰질 때까지 흐리거나 잘려 보인다.
                  ...(clampViewport(viewport) ??
                    viewportSize(event.sender) ?? {
                      width: host.desktopWidth,
                      height: host.desktopHeight,
                    }),
                  primary: true,
                },
              ],
              displayIds: [],
            };
      console.log(
        `[rdp] connecting with ${layout.monitors.length} monitor(s):`,
        layout.monitors.map((m) => `${m.width}x${m.height}`).join(", "),
        // 렌더러가 잰 값인지 창 크기로 대신한 것인지. 화면이 창에 안 맞을 때 여기부터 본다.
        clampViewport(viewport) ? "(pane)" : "(window fallback)",
      );

      // 원격 모니터 번호 ↔ 물리 화면을 잇는 유일한 연결고리다. 접속 뒤에 저장하면 그 사이에
      // 도착한 펼치기 요청이 빈손이 된다.
      displayIdsBySession.set(sessionId, layout.displayIds);

      try {
        return await rdpManager.connect(sessionId, {
          host: host.hostname,
          port: host.port,
          username: host.username,
          password: secrets.password ?? "",
          domain: host.domain ?? null,
          // 호스트에 고른 모니터가 있으면 그 배치를 빌려주고, 없으면 설정한 한 화면만 쓴다.
          monitors: layout.monitors,
          share: host.drivePath
            ? {
                // 원격 탐색기에 이 이름으로 뜬다. 호스트 라벨을 쓰면 어느 기기의 폴더인지
                // 원격에서 바로 보인다.
                label: host.label || "Dolgate",
                path: host.drivePath,
                readOnly: host.driveReadOnly === true,
              }
            : null,
        });
      } finally {
        hostBySession.delete(sessionId);
      }
    },
  );

  ipcMain.handle(ipcChannels.rdp.disconnect, async (_event, sessionId: string) => {
    // 세션이 끊기면 펼쳐 둔 창도 같이 내려야 한다. 안 그러면 검은 전체화면 창이 화면을 덮은 채
    // 남아 사용자가 닫을 방법이 없다(프레임이 없어서 닫기 버튼도 없다).
    await monitorWindows.close(sessionId);
    displayIdsBySession.delete(sessionId);
    rdpManager.disconnect(sessionId);
  });

  // 배치도 UI 가 그릴 목록. 좌표는 DIP 그대로 넘긴다 — 그리기에는 배율이 필요 없고, 화면별
  // 배율을 곱하면 오히려 배치가 무너진다.
  ipcMain.handle(ipcChannels.rdp.listMonitors, async (): Promise<RdpLocalMonitor[]> => {
    const primary = screen.getPrimaryDisplay();
    return screen.getAllDisplays().map((display) => ({
      id: display.id,
      label: display.label,
      left: display.bounds.x,
      top: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      primary: display.id === primary.id,
    }));
  });

  // 픽셀을 보낼 창을 좁힌다. 창이 닫히면 등록을 지워 죽은 id 가 남지 않게 한다.
  ipcMain.on(ipcChannels.rdp.watch, (event, sessionId: string) => {
    const id = event.sender.id;
    rdpManager.watchSession(sessionId, id);
    event.sender.once("destroyed", () => rdpManager.forgetWatcher(id));
  });

  ipcMain.on(ipcChannels.rdp.unwatch, (event, sessionId: string) => {
    rdpManager.unwatchSession(sessionId, event.sender.id);
  });

  // 세션 도중에 붙는 창(모니터별 창)이 한 번만 부른다. 자동으로 걸지 않는 이유는 rdp-manager
  // 의 watchSession 주석 참고 — 등록마다 부르면 전체 프레임이 몰아쳐 파이프를 다 먹는다.
  ipcMain.on(ipcChannels.rdp.refresh, (_event, sessionId: string) => {
    rdpManager.requestRefresh(sessionId);
  });

  ipcMain.handle(
    ipcChannels.rdp.describeSession,
    async (_event, sessionId: string) => rdpManager.describeSession(sessionId),
  );

  ipcMain.handle(ipcChannels.rdp.pickShareFolder, async () => {
    const result = await dialog.showOpenDialog({
      title: "Choose a folder to share with the remote session",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  // 원격에서 복사된 텍스트를 로컬 클립보드에 넣는다. 클립보드는 메인 프로세스가 소유한다.
  rdpManager.onRemoteClipboardText = (text) => {
    // 같은 값을 다시 쓰면 clipboard 변경 감지가 한 바퀴 더 돌아 원격으로 되돌아간다.
    if (clipboard.readText() !== text) {
      clipboard.writeText(text);
    }
  };

  ipcMain.on(
    ipcChannels.rdp.clipboard,
    (_event, sessionId: string, text: string) => {
      rdpManager.sendClipboardText(sessionId, text);
    },
  );

  // 원격 화면에 포커스가 갈 때 로컬 클립보드를 밀어 넣는다.
  //
  // 붙여넣기 순간에 읽을 수는 없다. 키 입력을 원격으로 보내려면 keydown 에서
  // preventDefault 를 해야 하는데, 그러면 브라우저가 paste 이벤트를 만들지 않는다. 그리고
  // 붙여넣는 그 순간에 알려 봐야 서버의 데이터 요청과 경쟁한다 — 미리 올려둬야 한다.
  ipcMain.on(ipcChannels.rdp.syncClipboard, (_event, sessionId: string) => {
    const text = clipboard.readText();
    if (text) {
      rdpManager.sendClipboardText(sessionId, text);
    }
  });

  ipcMain.on(
    ipcChannels.rdp.resize,
    (_event, sessionId: string, width: number, height: number) => {
      rdpManager.requestResize(sessionId, width, height);
    },
  );

  // 마우스 이동만으로도 초당 수십 번 오므로 invoke 대신 단방향 send 를 쓴다 — 응답을 기다릴
  // 이유가 없고, 왕복이 그대로 입력 지연이 된다.
  /**
   * 화면 좌표로 온 이동을 데스크톱 좌표로 옮긴다.
   *
   * 모니터마다 창을 펼쳤을 때 렌더러가 화면 좌표로 보낸다 — 버튼을 누른 채 드래그하면 OS 가
   * 이후 이벤트를 처음 누른 창에만 보내서, 그 창이 자기 캔버스 기준으로는 옆 모니터를 표현할 수
   * 없기 때문이다. 어느 창이 받았든 화면 좌표는 같으므로 여기서 한 번에 옮긴다.
   *
   * 옮길 수 없는 위치(화면 사이 빈 공간, 이 세션이 안 빌린 화면)는 버린다.
   */
  function toDesktopEvents(
    sessionId: string,
    events: RdpInputEvent[],
  ): RdpInputEvent[] {
    if (!events.some((event) => event.kind === "mouseMoveScreen")) {
      return events;
    }

    const displayIds = displayIdsBySession.get(sessionId);
    const placements = rdpManager.describeSession(sessionId)?.monitors;
    if (!displayIds || !placements) {
      return events.filter((event) => event.kind !== "mouseMoveScreen");
    }

    const known = displays();
    return events.flatMap((event) => {
      if (event.kind !== "mouseMoveScreen") {
        return [event];
      }
      const mapped = mapScreenPointToDesktop(event, known, {
        displayIds,
        placements,
      });
      return mapped ? [{ kind: "mouseMove" as const, ...mapped }] : [];
    });
  }

  ipcMain.on(
    ipcChannels.rdp.input,
    (_event, sessionId: string, events: RdpInputEvent[]) => {
      rdpManager.sendInput(sessionId, toDesktopEvents(sessionId, events));
    },
  );
}

/**
 * 로컬 디스플레이 배치를 RDP 가 이해하는 형태로 옮긴다.
 *
 * Electron 의 bounds 는 이미 주 디스플레이를 원점으로 하는 좌표계라 RDP 의 선언 공간과 같다 —
 * 주 모니터 왼쪽/위의 화면은 음수가 된다. 그대로 넘기면 코어가 바운딩 박스를 계산한다.
 *
 * 크기는 scaleFactor 를 곱해 실제 픽셀로 낸다. 논리 크기를 그대로 보내면 HiDPI 화면에서 원격
 * 해상도가 절반으로 잡힌다.
 */
/** [MS-RDPEDISP] 2.2.2.2.1 이 허용하는 한 변의 최대 픽셀. */
const MAX_DESKTOP_SIDE = 8192;

/**
 * 이 창이 원격 화면을 보여줄 크기.
 *
 * 창의 논리 크기를 그대로 쓴다. 배율을 곱하면 원격 데스크톱이 창보다 훨씬 넓어져서 — 배율 2
 * 화면이면 네 배 — 글자가 깨알같이 작아지고, 화면 갱신도 네 배로 늘어 소리가 그 뒤로 밀린다.
 *
 * 창을 못 찾으면 null. 부르는 쪽이 예전 값으로 돌아간다.
 */
/** 렌더러가 잰 크기를 프로토콜이 받아들이는 범위로 맞춘다. */
function clampViewport(
  viewport?: { width: number; height: number },
): { width: number; height: number } | null {
  if (!viewport || viewport.width < 1 || viewport.height < 1) {
    return null;
  }
  // [MS-RDPEDISP] 2.2.2.2.1: 양변 200~8192, 폭은 홀수 금지.
  return {
    width:
      Math.min(MAX_DESKTOP_SIDE, Math.max(200, Math.round(viewport.width))) & ~1,
    height: Math.min(MAX_DESKTOP_SIDE, Math.max(200, Math.round(viewport.height))),
  };
}

function viewportSize(sender: WebContents): { width: number; height: number } | null {
  const window = BrowserWindow.fromWebContents(sender);
  if (!window || window.isDestroyed()) {
    return null;
  }

  const bounds = window.getContentBounds();

  // [MS-RDPEDISP] 2.2.2.2.1: 양변 200~8192, 폭은 홀수 금지.
  const width =
    Math.min(MAX_DESKTOP_SIDE, Math.max(200, Math.round(bounds.width))) & ~1;
  const height = Math.min(MAX_DESKTOP_SIDE, Math.max(200, Math.round(bounds.height)));

  return { width, height };
}

function describeLocalMonitors(selection?: RdpMonitorSelection[] | null) {
  const all = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();

  // 저장된 선택이 지금 환경과 하나도 안 맞으면(다른 자리로 옮겨 왔다거나) 전부 쓴다. 임의의
  // 화면 하나를 골라 주면 사용자는 왜 그 화면만 떴는지 알 수 없다.
  const chosen = resolveSelectedDisplays(all, selection);
  const displays = chosen.length > 0 ? chosen : all;
  if (selection && selection.length > 0 && chosen.length === 0) {
    console.warn(
      "[rdp] none of the saved monitors are attached; using every display",
    );
  }

  // 화면마다 자기 scaleFactor 를 곱하면 안 된다. bounds 는 모든 디스플레이가 공유하는 하나의
  // 좌표계(DIP)인데, 화면별로 다른 배율을 곱하면 위치와 크기가 서로 다른 단위가 되어 배치가
  // 무너진다. 배율은 전체에 하나만 적용한다.
  //
  // 그 배율도 무조건 크게 잡으면 안 된다. 원격 데스크톱은 모든 모니터를 감싸는 하나의 사각형
  // 이고, 모니터가 떨어져 있으면 빈 공간까지 포함해 아주 커진다. 한 변이 8192 를 넘으면 서버가
  // 거부하고, 그 전에 프레임버퍼가 수백 MB 가 된다(9856x5348 이면 약 210MB).
  //
  // 그래서 배율을 주 디스플레이 값부터 1 까지 낮춰 보며 상한에 드는 첫 값을 쓴다.
  const scale = chooseScale(displays, primary.scaleFactor || 1);

  // 주 디스플레이를 선택에서 뺐을 수 있다. 그때는 고른 것 중 첫 번째가 주가 된다 — 아무것도
  // 주로 표시하지 않으면 원격이 임의로 정하고, 시작 메뉴와 작업표시줄이 엉뚱한 화면에 붙는다.
  const primaryId = displays.some((display) => display.id === primary.id)
    ? primary.id
    : displays[0]?.id;

  const monitorDisplayIds = displays.map((display) => display.id);
  const monitors = displays.map((display) => ({
    width: Math.round(display.bounds.width * scale),
    height: Math.round(display.bounds.height * scale),
    left: Math.round(display.bounds.x * scale),
    top: Math.round(display.bounds.y * scale),
    primary: display.id === primaryId,
  }));

  const box = boundingBox(monitors);
  if (box.width > MAX_DESKTOP_SIDE || box.height > MAX_DESKTOP_SIDE) {
    // 1배로도 안 들어간다. 모니터가 아주 멀리 떨어진 배치다. 전체를 포기하고 주 화면만 쓴다 —
    // 서버가 거부해 검은 화면이 되는 것보다 한 화면이라도 보이는 편이 낫다.
    console.warn(
      `[rdp] monitor layout spans ${box.width}x${box.height}, over the ${MAX_DESKTOP_SIDE} limit; using the primary display only`,
    );
    const onlyIndex = Math.max(
      0,
      monitors.findIndex((m) => m.primary),
    );
    const only = monitors[onlyIndex];
    return {
      monitors: [{ ...only, left: 0, top: 0, primary: true }],
      displayIds: [monitorDisplayIds[onlyIndex]],
    };
  }

  // 배치가 의도와 다르게 잡히는 일이 잦아(회전·세로 배치·혼합 DPI) 무엇을 선언했는지 남긴다.
  console.log(
    `[rdp] declaring monitors (scale ${scale}, desktop ${box.width}x${box.height}):`,
    monitors
      .map(
        (m) =>
          `${m.width}x${m.height}@(${m.left},${m.top})${m.primary ? " primary" : ""}`,
      )
      .join("  "),
  );

  return { monitors, displayIds: monitorDisplayIds };
}

function boundingBox(
  monitors: Array<{ width: number; height: number; left: number; top: number }>,
) {
  const left = Math.min(...monitors.map((m) => m.left));
  const top = Math.min(...monitors.map((m) => m.top));
  const right = Math.max(...monitors.map((m) => m.left + m.width));
  const bottom = Math.max(...monitors.map((m) => m.top + m.height));
  return { width: right - left, height: bottom - top };
}

/** 상한에 드는 가장 큰 배율을 고른다. 못 찾으면 1 을 돌려주고 호출부가 판단한다. */
function chooseScale(
  displays: readonly { bounds: Electron.Rectangle }[],
  preferred: number,
): number {
  for (let scale = Math.max(1, Math.floor(preferred)); scale >= 1; scale -= 1) {
    const box = boundingBox(
      displays.map((display) => ({
        width: display.bounds.width * scale,
        height: display.bounds.height * scale,
        left: display.bounds.x * scale,
        top: display.bounds.y * scale,
      })),
    );
    if (box.width <= MAX_DESKTOP_SIDE && box.height <= MAX_DESKTOP_SIDE) {
      return scale;
    }
  }
  return 1;
}

/** 렌더러의 프롬프트 응답을 기다리는 대기표. */
export function createCertificatePromptBridge(
  broadcast: (event: RdpSessionEvent) => void,
) {
  const pending = new Map<string, (accept: boolean) => void>();

  ipcMain.handle(
    ipcChannels.rdp.trustCertificate,
    async (_event, sessionId: string, accept: boolean) => {
      const resolve = pending.get(sessionId);
      if (resolve) {
        pending.delete(sessionId);
        resolve(accept);
      }
    },
  );

  return {
    ask(prompt: RdpCertificatePrompt): Promise<boolean> {
      return new Promise<boolean>((resolve) => {
        // 같은 세션에 프롬프트가 두 번 뜰 일은 없지만, 남아 있으면 거절로 정리한다.
        pending.get(prompt.sessionId)?.(false);
        pending.set(prompt.sessionId, resolve);
        broadcast({
          type: "certificatePrompt",
          sessionId: prompt.sessionId,
          prompt,
        });
      });
    },
    /** 세션이 사라지면 대기 중인 프롬프트를 거절로 닫는다. */
    cancel(sessionId: string): void {
      const resolve = pending.get(sessionId);
      if (resolve) {
        pending.delete(sessionId);
        resolve(false);
      }
    },
  };
}
