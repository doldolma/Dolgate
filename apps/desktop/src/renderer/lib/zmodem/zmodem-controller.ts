// 세션당 ZMODEM Sentry 래퍼. 터미널 수신 스트림을 가로채 `sz`(다운로드)만 처리한다.
//  - 모든 수신 청크를 sentry.consume에 먼저 먹인다 → 일반 출력은 to_terminal로 통과,
//    ZMODEM 프로토콜 바이트는 가로채 화면/공유/E2E에 도달하지 않는다.
//  - 수신(receive) 세션의 offer는 메모리에 모은 뒤 Downloads에 저장한다.
//  - 송신(send=rz)은 미지원(업로드는 터미널 드래그=SFTP). 감지 시 중단한다.
//  - sessionId 키잉이라 재연결 시 컨트롤러가 dispose되어 진행 중 전송은 abort된다.

// dist(main 필드)는 `<script>`용 빌드라 module.exports가 비어 있고 API를 window.Zmodem
// 전역에만 붙인다 — 번들 환경에선 그 전역이 안 잡혀 동작하지 않았다. 대신 CommonJS
// 소스 엔트리(index.js)에서 Sentry를 직접 가져온다(전역/번들 비의존).
import ZmodemLib from "nora-zmodemjs/index.js";
import type {
  ZmodemDetection,
  ZmodemNamespace,
  ZmodemOffer,
  ZmodemSession,
} from "nora-zmodemjs";
import type { TransferJob } from "@shared";

// 호출 시점에 해석한다: 테스트가 window.Zmodem으로 모의 객체를 주입하면 그것을 쓰고,
// 아니면 정적 import한 실제 라이브러리를 쓴다.
function resolveZmodem(): ZmodemNamespace | undefined {
  const injected =
    typeof window !== "undefined"
      ? (window as unknown as { Zmodem?: ZmodemNamespace }).Zmodem
      : undefined;
  return injected ?? ZmodemLib;
}

// 메모리에 통째로 버퍼링하므로 상한을 둔다(초과 시 SFTP 권장).
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const PROGRESS_EMIT_INTERVAL_MS = 100;

export interface ZmodemControllerDeps {
  sessionId: string;
  hostLabel: string;
  // false면 Sentry를 달지 않고 출력을 그대로 통과시킨다(예: SSM은 채널이 ZMODEM
  // 바이너리를 신뢰성 있게 전달하지 못해 비활성). 기본 동작은 활성.
  enabled?: boolean;
  writeToTerminal: (bytes: Uint8Array) => void;
  sendToRemote: (bytes: Uint8Array) => void;
  saveDownload: (input: {
    name: string;
    bytes: Uint8Array;
  }) => Promise<{ savedPath: string }>;
  upsertJob: (job: TransferJob) => void;
  registerAbort: (jobId: string, abort: () => void) => void;
  clearAbort: (jobId: string) => void;
}

export interface ZmodemController {
  consume: (chunk: Uint8Array) => void;
  dispose: () => void;
}

function toUint8(octets: number[] | Uint8Array): Uint8Array {
  return octets instanceof Uint8Array ? octets : Uint8Array.from(octets);
}

function mergeChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

export function createZmodemController(
  deps: ZmodemControllerDeps,
): ZmodemController {
  const Zmodem = resolveZmodem();
  if (!Zmodem || deps.enabled === false) {
    // 라이브러리 미로드 또는 비활성(예: SSM) — ZMODEM을 달지 않고 출력 그대로 통과.
    return {
      consume: (chunk: Uint8Array) => deps.writeToTerminal(chunk),
      dispose: () => {},
    };
  }
  const zmodemLib = Zmodem;
  let activeSession: ZmodemSession | null = null;
  let disposed = false;
  const canceledJobIds = new Set<string>();

  const nowIso = () => new Date().toISOString();

  const buildSentry = () =>
    new zmodemLib.Sentry({
      to_terminal: (octets) => {
        deps.writeToTerminal(toUint8(octets));
      },
      sender: (octets) => {
        deps.sendToRemote(toUint8(octets));
      },
      on_retract: () => {
        // ZMODEM 감지가 철회됨(오탐). Sentry가 이후 입력을 정상 통과시키므로 별도 처리 없음.
      },
      on_detect: (detection) => {
        handleDetect(detection);
      },
    });

  let sentry = buildSentry();

  function handleDetect(detection: ZmodemDetection): void {
    if (disposed || activeSession) {
      detection.deny();
      return;
    }
    const session = detection.confirm();
    // 업로드(rz)는 미지원 — 파일 업로드는 터미널 드래그(SFTP)로 한다. 세션을 중단한다.
    if (session.type === "send") {
      try {
        session.abort();
      } catch {
        // ignore
      }
      return;
    }
    activeSession = session;
    session.on("offer", (offer) => {
      void handleOffer(offer);
    });
    session.on("session_end", () => {
      activeSession = null;
    });
    session.start();
  }

  async function handleOffer(offer: ZmodemOffer): Promise<void> {
    const details = offer.get_details();
    const name = details.name || "download";
    const size = typeof details.size === "number" ? details.size : 0;
    const jobId = globalThis.crypto.randomUUID();
    const startedAt = nowIso();
    const startedAtMs = performance.now();

    const baseJob = (): TransferJob => ({
      id: jobId,
      sourceLabel: deps.hostLabel,
      targetLabel: "Downloads",
      itemCount: 1,
      bytesTotal: size,
      bytesCompleted: 0,
      status: "running",
      startedAt,
      activeItemName: name,
      updatedAt: nowIso(),
    });

    if (size > MAX_DOWNLOAD_BYTES) {
      offer.skip();
      deps.upsertJob({
        ...baseJob(),
        status: "failed",
        errorMessage: "파일이 너무 큽니다(512MB 초과). SFTP를 사용하세요.",
        updatedAt: nowIso(),
      });
      return;
    }

    deps.registerAbort(jobId, () => {
      canceledJobIds.add(jobId);
      try {
        activeSession?.abort();
      } catch {
        // ignore
      }
    });
    deps.upsertJob(baseJob());

    const chunks: Uint8Array[] = [];
    let received = 0;
    let lastEmit = 0;
    offer.on("input", (octets) => {
      const bytes = toUint8(octets);
      chunks.push(bytes);
      received += bytes.length;
      const now = performance.now();
      if (now - lastEmit >= PROGRESS_EMIT_INTERVAL_MS) {
        lastEmit = now;
        const elapsed = (now - startedAtMs) / 1000;
        const speed = elapsed > 0 ? received / elapsed : 0;
        const remaining = size > received ? size - received : 0;
        deps.upsertJob({
          ...baseJob(),
          bytesCompleted: received,
          speedBytesPerSecond: speed,
          etaSeconds: speed > 0 ? Math.round(remaining / speed) : null,
          updatedAt: nowIso(),
        });
      }
    });

    try {
      await offer.accept();
      const merged = mergeChunks(chunks, received);
      const { savedPath } = await deps.saveDownload({ name, bytes: merged });
      deps.upsertJob({
        ...baseJob(),
        bytesTotal: received,
        bytesCompleted: received,
        status: "completed",
        detailMessage: savedPath,
        updatedAt: nowIso(),
      });
    } catch (error) {
      deps.upsertJob({
        ...baseJob(),
        bytesCompleted: received,
        status: canceledJobIds.has(jobId) ? "cancelled" : "failed",
        errorMessage: canceledJobIds.has(jobId)
          ? undefined
          : error instanceof Error
            ? error.message
            : "다운로드에 실패했습니다.",
        updatedAt: nowIso(),
      });
    } finally {
      canceledJobIds.delete(jobId);
      deps.clearAbort(jobId);
    }
  }

  return {
    consume: (chunk: Uint8Array) => {
      if (disposed) {
        return;
      }
      try {
        sentry.consume(chunk);
      } catch (error) {
        console.warn(
          "[zmodem] consume error",
          { hadSession: Boolean(activeSession) },
          error,
        );
        if (activeSession) {
          // 세션 진행 중 파싱 오류(예: SSM 채널이 8-bit clean하지 않아 프레임 훼손).
          // raw 청크를 화면에 덤프하면 깨진 문자가 폭주하므로, 세션을 정리(abort)해
          // 원격 sz를 멈추게 하고 화면 오염을 막는다.
          try {
            activeSession.abort();
          } catch {
            // ignore
          }
          activeSession = null;
        } else {
          // 세션 시작 전 파싱 오류: 터미널이 멈추지 않도록 원본을 흘린다.
          deps.writeToTerminal(chunk);
        }
        try {
          sentry = buildSentry();
        } catch {
          // ignore
        }
      }
    },
    dispose: () => {
      disposed = true;
      if (activeSession) {
        try {
          activeSession.abort();
        } catch {
          // ignore
        }
        activeSession = null;
      }
    },
  };
}
