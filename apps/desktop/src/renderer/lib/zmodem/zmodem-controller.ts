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
import { t } from '../../i18n';
import { createTerminalHeaderFilter } from './terminal-header-filter';

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

// ZMODEM 시작 신호(`**` ZDLE `B` 헥스…)에 들어가는 바이트.
const ZPAD = 0x2a; // '*'
const ZDLE = 0x18;
// 취소 신호(CAN 여러 개 + BS 여러 개). CAN 은 ZDLE 와 같은 바이트다.
const CAN = 0x18;
const BS = 0x08;
/**
 * 감지기에 넣어야 하는 조각 다음으로 이만큼은 계속 감지기에 넣는다. 시작 신호는 ZDLE 뒤로 20바이트
 * 남짓(`B` + 헥스 14자 + CR LF + XON)이 더 이어지는데, 그 꼬리가 다음 조각으로 넘어갈 수 있고 꼬리에는
 * '*'·ZDLE 가 없다.
 */
const SENTRY_FOLLOW_BYTES = 64;
/**
 * 받기 세션이 이만큼 아무 진행(파일 데이터·세션 사건)이 없으면 원격 sz 가 사라진 것으로 보고 이쪽에서만
 * 끝낸다. sz 가 취소 신호 없이 죽으면(SIGKILL 등) 세션이 다음 프레임을 영영 기다리며 셸 출력을 삼켜, 탭이
 * 굳은 것처럼 보였다(실측: 3분 넘게, 취소를 눌러도 그대로).
 */
const RECEIVE_STALL_MS = 10_000;
/** 취소에 원격이 이만큼 답하지 않으면 이쪽에서만 끝낸다(sz 가 이미 없을 수 있다). */
const CANCEL_REPLY_TIMEOUT_MS = 3_000;
/**
 * 격리 중 ZDLE 없는 조각은 이만큼 붙잡아 둔다. 그 사이 ZDLE 든 조각이 오면 아직 전송 데이터가 오는 중이었으니
 * 버리고, 안 오면 셸 출력으로 보고 화면에 보낸다.
 */
const QUARANTINE_HOLD_MS = 300;
/** 격리 중 취소 신호가 조각 경계에 걸쳐도 찾도록 앞 조각 끝을 이만큼 붙여 본다. */
const QUARANTINE_TAIL_BYTES = 32;
/** 라이브러리가 받는 즉시 지우는 바이트(strip_ignored_bytes: XON·XOFF 와 그 8비트 판). */
const STRIPPED_BYTES = new Set([0x11, 0x13, 0x91, 0x93]);
/**
 * 감지기에 넣은 원래 조각을 이만큼(바이트) 남겨 둔다. 지운 바이트를 되살릴 때 쓴다(restoreStrippedBytes). 멈춘
 * 세션이 삼킨 셸 출력은 키 입력 메아리처럼 잘게 오기도 해서 조각 수가 아니라 바이트로 센다.
 */
const RECENT_INPUT_BYTES = 64 * 1024;
/** 셸 통합의 "명령이 끝났다" 표시(OSC 133;D). 이것이 오면 셸이 다시 터미널을 잡은 것이다. */
const COMMAND_FINISHED_MARKER = Uint8Array.from([0x1b, 0x5d, 0x31, 0x33, 0x33, 0x3b, 0x44]);

/**
 * 이 조각에서 전송이 시작될 수 있는가.
 *
 * 시작 신호는 늘 ZDLE 를 품는다. ZDLE 가 없는 조각에서 신호가 시작될 수 있는 것은 끝이 '*' 라서 다음
 * 조각에서 이어지는 경우뿐이다. 예전에는 '*' 가 어디에 있든 감지기로 보냈는데, 코어가 출력을 32KB
 * 까지 합쳐 보내면서 소스 코드·마크다운처럼 '*' 가 흔한 출력은 거의 모든 조각이 느린 감지기로 갔다.
 */
function mayStartTransfer(chunk: Uint8Array): boolean {
  return chunk.indexOf(ZDLE) !== -1 || chunk[chunk.length - 1] === ZPAD;
}

/**
 * 받기 세션이 상대의 ZFIN 을 받은 뒤 쌓인 바이트. ZFIN 을 받기 전이면 null.
 *
 * ZFIN 뒤에는 "OO" 만 와야 해서, 원격 `sz` 가 "OO" 없이 끝나면 곧바로 온 셸 프롬프트에 라이브러리가 PROTOCOL
 * 예외를 던진다(PTY 로 돈 lrzsz 0.12.21 은 대개 "OO" 를 보내지 않는다 — 실측, 파이프로는 보낸다). 그때 쌓인
 * 바이트가 그 프롬프트다. 라이브러리(nora-zmodemjs 1.1.1)의 내부 필드다 — 공개 API 에는 이 상태가 없다.
 * 라이브러리가 지운 바이트가 빠져 있다(restoreStrippedBytes).
 */
function bytesAfterZfin(session: ZmodemSession): number[] | null {
  const internals = session as unknown as { type?: string; _got_ZFIN?: boolean; _input_buffer?: unknown };
  if (internals.type !== "receive" || internals._got_ZFIN !== true) {
    return null;
  }
  return Array.isArray(internals._input_buffer) ? (internals._input_buffer as number[]).slice() : [];
}

/**
 * 라이브러리가 지운 바이트까지 되살린 원래 바이트.
 *
 * 라이브러리 버퍼는 받는 즉시 0x11·0x13·0x91·0x93 을 지운 것이라, 그대로 화면에 보내면 한글이 깨졌다(실측:
 * '드' = EB 93 9C 에서 0x93 이 빠져 `~/다운로$`). 받은 원래 조각을 끝에서부터 거슬러, 지워지지 않는 바이트를
 * 버퍼 길이만큼 센 자리부터 자른다. 자른 것을 같은 규칙으로 지운 결과가 버퍼와 다르면 버퍼를 그대로 쓴다.
 */
function restoreStrippedBytes(stripped: number[], originals: readonly Uint8Array[]): Uint8Array {
  const joined = mergeChunks([...originals], originals.reduce((sum, chunk) => sum + chunk.length, 0));
  let start = joined.length;
  for (let kept = 0; start > 0 && kept < stripped.length; ) {
    start -= 1;
    if (!STRIPPED_BYTES.has(joined[start]!)) {
      kept += 1;
    }
  }
  const candidate = joined.subarray(start);
  let matched = 0;
  for (const byte of candidate) {
    if (STRIPPED_BYTES.has(byte)) {
      continue;
    }
    if (byte !== stripped[matched]) {
      return Uint8Array.from(stripped);
    }
    matched += 1;
  }
  return matched === stripped.length ? candidate : Uint8Array.from(stripped);
}

/**
 * 받기 세션이 마지막으로 헤더·데이터 조각을 해석한 뒤 받은 바이트에 셸 통합의 "명령 끝" 표시(OSC 133;D)가
 * 있으면, 그 표시부터 아직 화면에 안 간 바이트. 표시가 없으면 null.
 *
 * 표시가 있으면 sz 는 끝났고 셸이 터미널을 잡은 것이다. sz 가 전송 중에 죽으면(SIGKILL) 데이터 조각 중간이던
 * 세션은 셸 출력을 버퍼(라이브러리 내부 필드 _input_buffer)에 쌓아 삼킨다(실측: 10초 뒤 입력은 됐지만 프롬프트가
 * 보이지 않았다). 헤더를 기다리던 세션은 헤더가 아닌 바이트를 버리는데(discarded), 감지기가 그것을 화면에
 * 보낸다(shown: 그중 앞에서부터 화면에 간 바이트 수).
 */
function shellOutputSwallowedBy(
  session: ZmodemSession,
  discarded: readonly number[],
  shown: number,
  originals: readonly Uint8Array[],
): Uint8Array | null {
  const buffered = (session as unknown as { _input_buffer?: unknown })._input_buffer;
  const received = discarded.concat(Array.isArray(buffered) ? (buffered as number[]) : []);
  const markerAt = indexOfBytes(Uint8Array.from(received), COMMAND_FINISHED_MARKER);
  return markerAt === -1 ? null : restoreStrippedBytes(received.slice(Math.max(markerAt, shown)), originals);
}

/**
 * 받는 쪽이 첫 인사(ZRINIT)에 거는 깃발. 앞 셋은 라이브러리 기본값 그대로이고, ESCCTL 은 "제어 문자를 모두
 * 이스케이프해 달라"는 요청이다(ZMODEM 규격의 깃발 — 원조 sz·lrzsz 모두 받으면 따른다, 원본 확인).
 */
const RECEIVER_FLAGS = ['CANFDX', 'CANOVIO', 'CANFC32', 'ESCCTL'];

/**
 * sz 에게 제어 문자를 모두 이스케이프해 달라고 한다. 사용자가 `sz -e` 라고 치는 것과 같다.
 *
 * lrzsz 는 기본으로 ESC·줄바꿈 같은 제어 문자를 날것으로 보내서, 전송이 비정상으로 끝난 뒤 남은 데이터를 셸
 * 출력과 가를 수 없었다 — 셸 통합 표시가 든 파일 내용을 셸 출력으로 착각했고, 새어 나온 데이터가 색·문자셋 같은
 * 화면 상태를 바꿨다(재현). 이스케이프하면 날것의 ESC 는 셸에서만 오고, 새는 것이 있어도 글자뿐이다. 대가로
 * 바이너리는 회선 바이트가 22~46% 는다(실측).
 *
 * 라이브러리(nora-zmodemjs 1.1.1)는 이 깃발을 일부러 보내지 않고 바꿀 수단도 없어서, 첫 인사를 보내는 내부
 * 메서드(_send_ZRINIT)를 이 세션에서만 덮는다. 세션을 시작할 때와 파일을 하나 받을 때마다 이 메서드로 나간다.
 * 메서드가 없으면(판이 바뀜) 덮지 않고 예전처럼 동작한다.
 */
function requestEscapedControlCharacters(session: ZmodemSession): void {
  const internals = session as unknown as { _send_ZRINIT?: unknown; _send_header?: unknown };
  if (typeof internals._send_ZRINIT !== 'function' || typeof internals._send_header !== 'function') {
    return;
  }
  internals._send_ZRINIT = function sendReceiverInit(this: { _send_header(name: string, flags: string[]): void }) {
    this._send_header('ZRINIT', RECEIVER_FLAGS);
  };
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  for (let index = haystack.indexOf(needle[0]!); index !== -1; index = haystack.indexOf(needle[0]!, index + 1)) {
    if (index + needle.length > haystack.length) {
      return -1;
    }
    if (needle.every((byte, offset) => haystack[index + offset] === byte)) {
      return index;
    }
  }
  return -1;
}

/**
 * sz 의 취소 신호(CAN 5개 이상 + BS 5개 이상) 바로 뒤 위치. 없으면 -1.
 *
 * lrzsz 는 취소를 받거나 오류로 끝날 때 canit() 으로 CAN 10개 + BS 10개를 보낸다(원본 확인). ZMODEM 데이터
 * 안의 CAN(=ZDLE)은 이스케이프되므로 5개가 잇달아 나오는 것은 이 신호뿐이다.
 */
function findCancelSignalEnd(bytes: Uint8Array): number {
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== CAN) {
      continue;
    }
    let cans = index;
    while (cans < bytes.length && bytes[cans] === CAN) {
      cans += 1;
    }
    let backspaces = cans;
    while (backspaces < bytes.length && bytes[backspaces] === BS) {
      backspaces += 1;
    }
    if (cans - index >= 5 && backspaces - cans >= 5) {
      return backspaces;
    }
    index = cans - 1;
  }
  return -1;
}

export interface ZmodemControllerDeps {
  sessionId: string;
  hostLabel: string;
  // false면 출력을 그대로 통과시킨다. SSM 셸은 제외하되 SSH-over-SSM은 활성화한다.
  // 콜백은 연결 정보의 늦은 도착을 컨트롤러 재생성 없이 반영한다.
  enabled?: boolean | (() => boolean);
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
  const pendingFailures = new Set<(error: Error) => void>();
  const cancellationCompletions = new Set<() => void>();
  let quarantined = false;
  let draining = false;
  // 아직 감지기에 더 넣어야 하는 바이트 수(SENTRY_FOLLOW_BYTES).
  let sentryFollowBytes = 0;
  // 감지기에 넣은 최근 원래 조각(RECENT_INPUT_BYTES). 세션에 남은 바이트를 되살릴 때 쓴다(restoreStrippedBytes).
  let recentChunks: Uint8Array[] = [];
  let recentBytes = 0;
  // 받기 세션이 마지막으로 헤더·데이터 조각을 해석한 뒤 헤더가 아니라며 버린 바이트와, 그중 감지기가 화면에 보낸
  // 앞부분의 길이(shellOutputSwallowedBy). 감지기는 취소 중이 아니면 버린 바이트를 화면에 보낸다(to_terminal).
  let discardedSinceParse: number[] = [];
  let discardedShown = 0;
  // 격리 중 붙잡아 둔 ZDLE 없는 조각, 그것을 내보낼 타이머(QUARANTINE_HOLD_MS), 앞 조각 끝.
  let heldOutput: Uint8Array[] = [];
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let quarantineTail = new Uint8Array(0);
  // 받기 세션의 마지막 진행 시각과 그것을 보는 감시(RECEIVE_STALL_MS).
  let lastProgressAt = 0;
  let stallWatch: ReturnType<typeof setInterval> | null = null;
  const terminalFilter = createTerminalHeaderFilter(deps.writeToTerminal);

  const nowIso = () => new Date().toISOString();

  const buildSentry = () =>
    new zmodemLib.Sentry({
      to_terminal: (octets) => {
        if (!draining && !quarantined) terminalFilter.consume(toUint8(octets));
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

  const noteProgress = () => {
    lastProgressAt = Date.now();
  };

  const stopStallWatch = () => {
    if (stallWatch) {
      clearInterval(stallWatch);
      stallWatch = null;
    }
  };

  const rememberInput = (chunk: Uint8Array) => {
    recentChunks.push(chunk);
    recentBytes += chunk.length;
    while (recentBytes - recentChunks[0]!.length >= RECENT_INPUT_BYTES) {
      recentBytes -= recentChunks.shift()!.length;
    }
  };

  const forgetInput = () => {
    recentChunks = [];
    recentBytes = 0;
  };

  /** 받기 세션을 정리한다. 세션 끝, OO 없이 끝난 sz, 이쪽에서만 끝낼 때가 같이 쓴다. */
  function finishSession(): void {
    activeSession = null;
    draining = false;
    quarantined = false;
    sentryFollowBytes = 0;
    discardedSinceParse = [];
    discardedShown = 0;
    stopStallWatch();
    for (const complete of cancellationCompletions) complete();
  }

  /** 끊은 전송의 남은 바이트가 화면에 새지 않게 한다(consumeQuarantined). */
  function enterQuarantine(): void {
    quarantined = true;
    heldOutput = [];
    quarantineTail = new Uint8Array(0);
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
  }

  /** 격리를 끝내고, 붙잡아 두었던 조각을 돌려준다. */
  function leaveQuarantine(): Uint8Array[] {
    quarantined = false;
    sentryFollowBytes = 0;
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    const held = heldOutput;
    heldOutput = [];
    quarantineTail = new Uint8Array(0);
    return held;
  }

  /**
   * 받기 세션을 이쪽에서 버린다. 원격이 답하지 않거나, 취소에 답이 없거나, 프레임이 깨졌을 때다.
   *
   * - 세션이 받은 바이트에 셸의 "명령 끝" 표시가 있으면 sz 는 이미 끝났다(shellOutputSwallowedBy). 표시부터 아직
   *   화면에 안 간 것을 돌려준다. 표시 앞은 전송 찌꺼기와 섞여 있어 버린다.
   * - 없으면 취소 신호를 보내고 남은 바이트는 격리한다. SIGINT 를 받은 lrzsz sz 는 끝나지 않고 살아서 답을
   *   기다려(실측: 40초 넘게) 그동안 입력이 그 sz 로 가고 탭이 굳어 보였다. 신호를 받으면 sz 는 끝난다. 셸 통합이
   *   없어 sz 가 이미 없는 것을 모르면 셸에 ^X·BS 로 들어가는데, 빈 프롬프트에서는 아무 일도 하지 않는다.
   */
  function abandonSession(session: ZmodemSession, failure: Error | null): void {
    if (activeSession !== session) {
      return;
    }
    // 실패를 먼저 알린다 — abort() 가 부르는 session_end 는 "원격이 중단했다"로 알린다.
    if (failure) {
      for (const reject of pendingFailures) reject(failure);
    }
    const shellOutput = shellOutputSwallowedBy(session, discardedSinceParse, discardedShown, recentChunks);
    if (!shellOutput) {
      // abort() 는 CAN 을 5개만 보낸다. 데이터를 보내던 lrzsz sz 는 첫 CAN 을 끼어든 바이트로 읽고 나서 CAN 5개를
      // 더 세야 취소로 보기에, 4개만 남아 취소를 놓치고 제 시간 제한(실측: 60초)까지 살았다. lrzsz 의 canit() 처럼
      // 10개가 되게 먼저 더 보낸다.
      deps.sendToRemote(Uint8Array.of(CAN, CAN, CAN, CAN, CAN));
      try {
        session.abort();
      } catch {
        // ignore
      }
    }
    finishSession();
    forgetInput();
    sentry = buildSentry();
    if (!shellOutput) {
      enterQuarantine();
    } else if (shellOutput.length > 0) {
      consume(shellOutput);
    }
  }

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
    discardedSinceParse = [];
    discardedShown = 0;
    session.on("receive", () => {
      discardedSinceParse = [];
      discardedShown = 0;
    });
    session.on("garbage", (octets) => {
      discardedSinceParse = discardedSinceParse.concat(octets);
      if (!draining) {
        discardedShown = discardedSinceParse.length;
      }
      const excess = discardedSinceParse.length - RECENT_INPUT_BYTES;
      if (excess > 0) {
        discardedSinceParse = discardedSinceParse.slice(excess);
        discardedShown = Math.max(0, discardedShown - excess);
      }
    });
    noteProgress();
    stopStallWatch();
    stallWatch = setInterval(() => {
      if (Date.now() - lastProgressAt >= RECEIVE_STALL_MS) {
        abandonSession(session, new Error(t('zmodem.remoteStalled')));
      }
    }, 1000);
    session.on("offer", (offer) => {
      noteProgress();
      void handleOffer(offer);
    });
    session.on("session_end", () => {
      // 이쪽에서 먼저 끝낸 세션이면 할 일이 없다.
      if (activeSession !== session) {
        return;
      }
      finishSession();
      if (session.aborted?.()) {
        for (const reject of pendingFailures) reject(new Error(t('zmodem.remoteAborted')));
      }
    });
    requestEscapedControlCharacters(session);
    session.start();
  }

  async function handleOffer(offer: ZmodemOffer): Promise<void> {
    if (draining || disposed || quarantined) {
      try { await offer.skip(); } catch { /* Existing cancellation owns recovery. */ }
      return;
    }
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
        errorMessage: t('zmodem.tooLarge'),
        updatedAt: nowIso(),
      });
      return;
    }

    let rejectTransfer: (error: Error) => void = () => {};
    const interrupted = new Promise<never>((_, reject) => { rejectTransfer = reject; });
    pendingFailures.add(rejectTransfer);
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    const finishCancellation = () => rejectTransfer(new Error('cancelled'));
    const session = activeSession;
    deps.registerAbort(jobId, () => {
      if (canceledJobIds.has(jobId)) return;
      canceledJobIds.add(jobId);
      cancellationCompletions.add(finishCancellation);
      draining = true;
      // 원격이 답하면 세션이 끝나며 finishCancellation 이 불린다. 답이 없으면(sz 가 이미 없을 수 있다) 이쪽에서만
      // 끝낸다 — 예전에는 세션을 그대로 둬, 원격이 없으면 취소를 눌러도 탭이 풀리지 않았다(실측).
      const stop = () => {
        if (session) {
          abandonSession(session, null);
        }
      };
      cancelTimer = setTimeout(stop, CANCEL_REPLY_TIMEOUT_MS);
      try {
        // skip() can replace its internal promise on ZEOF. Session end, not
        // that promise, is the reliable acknowledgement that draining is done.
        Promise.resolve(offer.skip()).catch(stop);
      } catch {
        stop();
      }
    });
    deps.upsertJob(baseJob());

    const chunks: Uint8Array[] = [];
    let received = 0;
    let lastEmit = 0;
    offer.on("input", (octets) => {
      noteProgress();
      if (canceledJobIds.has(jobId) || disposed || quarantined) return;
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
      // Our input listener owns buffering; disable the library's duplicate spool.
      await Promise.race([offer.accept({ on_input: () => {} }), interrupted]);
      if (canceledJobIds.has(jobId)) await interrupted;
      if (disposed) throw new Error('Session closed');
      // Once local saving begins, the remote offer can no longer be cancelled.
      deps.clearAbort(jobId);
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
      // 사용자가 취소했으면, 원격이 답하지 않아 이쪽에서 끝냈어도 취소다(탭은 돌아온다).
      const cancelled = canceledJobIds.has(jobId);
      deps.upsertJob({
        ...baseJob(),
        bytesCompleted: received,
        status: cancelled ? "cancelled" : "failed",
        errorMessage: cancelled
          ? undefined
          : error instanceof Error
            ? error.message
            : t('zmodem.downloadFailed'),
        updatedAt: nowIso(),
      });
    } finally {
      clearTimeout(cancelTimer);
      pendingFailures.delete(rejectTransfer);
      cancellationCompletions.delete(finishCancellation);
      chunks.length = 0;
      canceledJobIds.delete(jobId);
      deps.clearAbort(jobId);
    }
  }

  /**
   * 끊은 전송의 남은 바이트를 걸러 낸다.
   *
   * - 셸 통합의 "명령 끝" 표시(OSC 133;D)부터는 셸 출력이라 바로 보내고, 그 앞은 버린다.
   * - sz 의 취소 신호(findCancelSignalEnd) 뒤도 셸 출력이라 바로 보낸다. 신호와 한 조각으로 온 프롬프트를 조각째
   *   버려, 프롬프트 없이 남았다(실측).
   * - ZDLE 가 든 조각은 아직 오는 전송 데이터라 버린다.
   * - ZDLE 없는 조각은 QUARANTINE_HOLD_MS 동안 붙잡아 두었다가, 그 사이 ZDLE 든 조각이 오지 않으면 보낸다. 첫
   *   조각에서 바로 풀어, 프레임이 큰 전송(sz -8)의 데이터가 화면에 쏟아졌다(실측).
   *
   * 예전에는 격리가 끝나지 않아 그 탭의 출력이 영영 버려지기도 했다(탭이 굳은 것처럼 보였다).
   */
  function consumeQuarantined(chunk: Uint8Array): void {
    const tailLength = quarantineTail.length;
    const joined = mergeChunks([quarantineTail, chunk], tailLength + chunk.length);
    // 셸 통합이 "명령이 끝났다"고 알리면 거기부터는 셸 출력이고, 그 앞은 전송 찌꺼기다(실측: 멈춘 sz 를 끝낸 뒤
    // 파일 데이터 조각이 프롬프트와 함께 풀려 나왔다). 앞 조각에 걸쳐 온 표시도 찾도록 꼬리를 붙여 본다.
    const markerAt = indexOfBytes(joined, COMMAND_FINISHED_MARKER);
    if (markerAt !== -1) {
      leaveQuarantine();
      consume(joined.slice(markerAt));
      return;
    }
    const signalEnd = findCancelSignalEnd(joined);
    if (signalEnd !== -1) {
      leaveQuarantine();
      const rest = joined.slice(signalEnd);
      if (rest.length > 0) {
        consume(rest);
      }
      return;
    }
    quarantineTail = joined.slice(Math.max(0, joined.length - QUARANTINE_TAIL_BYTES));
    if (chunk.indexOf(ZDLE) !== -1) {
      // 아직 전송 데이터가 오는 중이다. 붙잡아 둔 것도 그 일부였다.
      heldOutput = [];
      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
      return;
    }
    heldOutput.push(chunk);
    holdTimer ??= setTimeout(() => {
      holdTimer = null;
      if (disposed || !quarantined) {
        return;
      }
      for (const held of leaveQuarantine()) {
        consume(held);
      }
    }, QUARANTINE_HOLD_MS);
  }

  function consume(chunk: Uint8Array): void {
    if (disposed) {
      return;
    }
    if (quarantined && !activeSession) {
      consumeQuarantined(chunk);
      return;
    }
    // 연결 정보가 늦게 도착해도 Sentry를 재생성하지 않는다. 진행 중인 전송은 유지한다.
    if (!activeSession && typeof deps.enabled === 'function' && !deps.enabled()) {
      deps.writeToTerminal(chunk);
      return;
    }
    /**
     * 전송이 시작될 수 없는 조각은 감지기를 건너뛰고 바로 화면으로 보낸다.
     *
     * 감지기(라이브러리 Sentry)는 조각마다 바이트 배열을 JS 숫자 배열로 바꿔 내부 버퍼에 붙이고, 화면으로
     * 넘길 때 다시 바이트 배열로 바꾼다. 출력이 쏟아지면(0.5KB 조각이 초당 3만 개) 이것과 헤더 필터가
     * 메인 스레드의 60% 를 먹어 화면이 출력을 따라가지 못했다 — 감지를 끄면 같은 출력을 밀림 없이
     * 따라갔다(실측). 전송 중이거나, 시작 신호의 꼬리가 남았거나, 헤더 필터가 바이트를 붙잡고 있으면
     * 순서와 감지를 위해 그대로 감지기로 간다.
     */
    const startable = mayStartTransfer(chunk);
    if (
      !startable &&
      sentryFollowBytes === 0 &&
      !activeSession &&
      !draining &&
      terminalFilter.isIdle()
    ) {
      deps.writeToTerminal(chunk);
      return;
    }
    sentryFollowBytes = startable
      ? SENTRY_FOLLOW_BYTES
      : Math.max(0, sentryFollowBytes - chunk.length);
    rememberInput(chunk);
    try {
      sentry.consume(chunk);
    } catch (error) {
      const afterZfin = activeSession ? bytesAfterZfin(activeSession) : null;
      if (afterZfin) {
        // 파일은 다 받았고 원격 sz 는 이미 끝났다 — "OO" 자리에 셸 출력이 왔다. 세션을 정상으로 끝내고 남은
        // 바이트는 새 감지기로 다시 넣는다. 화면으로 바로 보내면, 바로 이어서 시작한 다음 sz(`sz a; sz b`)를
        // 감지하지 못해 그 sz 가 다시 알릴 때까지 기다렸다(실측: 둘째 파일 20초). 취소 바이트(abort)는
        // 보내지 않는다: 받을 sz 가 없어 셸에 ^X 로 들어간다.
        const rest = restoreStrippedBytes(afterZfin, recentChunks);
        finishSession();
        forgetInput();
        sentry = buildSentry();
        if (rest.length > 0) {
          consume(rest);
        }
        return;
      }
      console.warn(
        "[zmodem] consume error",
        { hadSession: Boolean(activeSession) },
        error,
      );
      if (activeSession) {
        // 세션 진행 중 파싱 오류(예: 채널이 8-bit clean하지 않아 프레임 훼손). raw 청크를 화면에 덤프하면
        // 깨진 문자가 폭주하므로, 세션을 버려 원격 sz를 멈추게 하고 남은 바이트는 격리한다. 새 감지기도 거기서 만든다.
        abandonSession(activeSession, new Error(t('zmodem.dataCorrupted')));
        return;
      }
      // 세션 시작 전 파싱 오류: 터미널이 멈추지 않도록 원본을 흘린다.
      deps.writeToTerminal(chunk);
      try {
        sentry = buildSentry();
      } catch {
        // ignore
      }
    }
  }

  return {
    consume,
    dispose: () => {
      disposed = true;
      terminalFilter.dispose();
      stopStallWatch();
      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
      for (const reject of pendingFailures) reject(new Error('Session closed'));
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
