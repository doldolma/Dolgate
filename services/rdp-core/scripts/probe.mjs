#!/usr/bin/env node
/**
 * rdp-core 를 앱 없이 직접 붙여 보는 개발용 도구.
 *
 * 왜 있는가: 화면·코덱 문제를 쫓을 때 Electron 을 띄우고 호스트를 등록하고 클릭해서 붙는 왕복이
 * 너무 길다. 사이드카는 stdin/stdout 으로만 말하므로 여기서 바로 몰아 볼 수 있다.
 *
 * 자격증명은 이 파일에 적지 않는다. `services/rdp-core/.env.local`(git 무시)에서 읽는다.
 *
 *   node scripts/probe.mjs                      # 붙어서 12초 보고 끊는다
 *   node scripts/probe.mjs --seconds 30         # 더 오래
 *   node scripts/probe.mjs --log debug          # rdp-core 로그 레벨
 *   node scripts/probe.mjs --no-egfx            # 그래픽 파이프라인 끄고
 *   node scripts/probe.mjs --layout '2560x1440@-2560,-458;1512x949@0,33*'
 *                                               # 붙은 뒤 배치를 다시 선언(멀티모니터 경로)
 *   node scripts/probe.mjs --refresh            # 전체 새로고침 한 번
 *   node scripts/probe.mjs --admin              # 관리 세션으로(mstsc /admin)
 *   node scripts/probe.mjs --no-audio           # 소리 채널 없이
 *   node scripts/probe.mjs --no-clipboard       # 클립보드 채널 없이
 *   node scripts/probe.mjs --color 16           # 16bit 색으로
 *
 * 비밀번호는 절대 출력하지 않는다.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const SERVICE_DIR = path.resolve(import.meta.dirname, "..");
const ENV_FILE = path.join(SERVICE_DIR, ".env.local");

// ── 설정 읽기 ────────────────────────────────────────────────────────────────

/** KEY=VALUE 만 읽는다. 따옴표는 벗기고, `#` 로 시작하는 줄은 건너뛴다. */
function readEnvFile(file) {
  if (!existsSync(file)) {
    return {};
  }
  const out = {};
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const fileEnv = readEnvFile(ENV_FILE);
// 셸에서 준 값이 파일보다 우선한다. 한 번만 다르게 붙어 볼 때 편하다.
const conf = (key, fallback = undefined) =>
  process.env[key] ?? fileEnv[key] ?? fallback;

function flag(name, fallback = null) {
  const at = process.argv.indexOf(`--${name}`);
  if (at < 0) {
    return fallback;
  }
  const next = process.argv[at + 1];
  return next && !next.startsWith("--") ? next : true;
}

/**
 * `2560x1440@-2560,-458;1512x982@0,0*` 를 모니터 목록으로 바꾼다. `*` 가 주 모니터다.
 *
 * 위치를 생략하면 (0,0) 이다: `1920x1080`.
 */
function parseMonitors(spec) {
  return spec
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const primary = entry.endsWith("*");
      const body = primary ? entry.slice(0, -1) : entry;
      const [size, position = "0,0"] = body.split("@");
      const [width, height] = size.split("x").map(Number);
      const [left, top] = position.split(",").map(Number);
      if (![width, height, left, top].every(Number.isFinite)) {
        throw new Error(`모니터 표기를 읽을 수 없다: ${entry}`);
      }
      return { width, height, left, top, primary };
    });
}

const host = conf("RDP_HOST");
const username = conf("RDP_USER");
const password = conf("RDP_PASSWORD", "");
if (!host || !username) {
  console.error(
    [
      `설정이 없다. ${path.relative(process.cwd(), ENV_FILE)} 를 만들어라:`,
      "",
      "  RDP_HOST=1.2.3.4",
      "  RDP_USER=Administrator",
      "  RDP_PASSWORD=...",
      "  # 아래는 없어도 된다",
      "  RDP_PORT=3389",
      "  RDP_DOMAIN=",
      "  RDP_MONITORS=1512x982@0,0*",
      "",
      "이 파일은 git 이 무시한다(.gitignore).",
    ].join("\n"),
  );
  process.exit(2);
}

const monitorFlag = flag("monitors");
const monitors = parseMonitors(
  typeof monitorFlag === "string"
    ? monitorFlag
    : conf("RDP_MONITORS", "1512x982@0,0*"),
);
const seconds = Number(flag("seconds", conf("RDP_SECONDS", "12")));
const logLevel = String(flag("log", conf("RDP_LOG", "info")));
const layoutSpec = flag("layout");
const wantRefresh = flag("refresh") === true;
const noEgfx = flag("no-egfx") === true;
const adminSession = flag("admin") === true;
const driveFlag = flag("drives");
const drivePaths = typeof driveFlag === "string" ? driveFlag.split(",") : [];
const audio = flag("no-audio") !== true;
const clipboard = flag("no-clipboard") !== true;
const colorFlag = flag("color");
const colorDepth = colorFlag === "16" ? 16 : undefined;

// ── 사이드카 띄우기 ──────────────────────────────────────────────────────────

const binary = ["release", "debug"]
  .map((profile) => path.join(SERVICE_DIR, "target", profile, "rdp-core"))
  .find((candidate) => existsSync(candidate));
if (!binary) {
  console.error("rdp-core 바이너리가 없다. 먼저: cargo build --release");
  process.exit(2);
}

console.log(
  `[probe] ${binary.includes("release") ? "release" : "debug"} → ${username}@${host}:${conf("RDP_PORT", "3389")}`,
  `monitors ${monitors.map((m) => `${m.width}x${m.height}@(${m.left},${m.top})${m.primary ? "*" : ""}`).join(" ")}`,
  `egfx ${noEgfx ? "off" : "on"}`,
  `session ${adminSession ? "admin" : "normal"}`,
  `audio ${audio ? "on" : "off"} clipboard ${clipboard ? "on" : "off"} color ${colorDepth ?? 32}`,
);

// 붙는 데 실패해도 반드시 끝난다. 접속 후에만 상한을 걸어 두면(처음 만들었을 때 그랬다) 접속이
// 실패하는 순간 매달린 채로 남는다 — 실패를 보러 쓰는 도구인데.
const deadline = setTimeout(
  () => {
    console.log(`[probe] ${seconds + 30}s 안에 끝나지 않았다 — 강제 종료`);
    finish(1);
  },
  (seconds + 30) * 1000,
);

const child = spawn(binary, [], {
  cwd: SERVICE_DIR,
  stdio: ["pipe", "pipe", "inherit"],
  env: {
    ...process.env,
    // 로그 레벨을 읽는 변수는 이것뿐이다(main.rs 의 with_env_var). RUST_LOG 는 안 본다.
    DOLGATE_RDP_LOG: logLevel,
    ...(noEgfx ? { DOLGATE_RDP_NO_EGFX: "1" } : {}),
  },
});

// ── 프레이밍 (apps/desktop/src/main/core-framing.ts 와 같은 형식) ────────────

const HEADER = 9;
let seq = 0;

function send(message) {
  const metadata = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(HEADER);
  header.writeUInt8(1, 0); // control
  header.writeUInt32BE(metadata.length, 1);
  header.writeUInt32BE(0, 5);
  child.stdin.write(Buffer.concat([header, metadata]));
}

function request(type, payload, sessionId) {
  const id = `probe-${++seq}`;
  send({ id, type, ...(sessionId ? { sessionId } : {}), payload });
  return id;
}

let buffered = Buffer.alloc(0);
// 세션 id 는 요청하는 쪽이 정한다(앱도 그렇게 한다). 이게 없으면 코어가 요청을 거절한다.
const sessionId = `probe-${randomUUID()}`;
let frames = 0;
let frameBytes = 0;

child.stdout.on("data", (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  for (;;) {
    if (buffered.length < HEADER) {
      return;
    }
    const kind = buffered.readUInt8(0);
    const metaLen = buffered.readUInt32BE(1);
    const payloadLen = buffered.readUInt32BE(5);
    const total = HEADER + metaLen + payloadLen;
    if (buffered.length < total) {
      return;
    }
    const metadata = JSON.parse(
      buffered.subarray(HEADER, HEADER + metaLen).toString("utf8"),
    );
    buffered = buffered.subarray(total);

    if (kind === 2) {
      // 화면·소리 조각. 내용은 볼 것이 없고 양만 본다.
      frames += 1;
      frameBytes += payloadLen;
      continue;
    }
    onEvent(metadata);
  }
});

function onEvent(event) {
  switch (event.type) {
    case "ready":
      request(
        "connectRdp",
        {
          host,
          port: Number(conf("RDP_PORT", "3389")),
          username,
          password,
          domain: conf("RDP_DOMAIN") || null,
          monitors,
          adminSession,
          audio,
          clipboard,
          colorDepth,
          // 여러 개 공유해 본다. label 은 앱이 경로에서 만들어 보내는 값과 같은 규칙으로 넣는다.
          drives: drivePaths.map((path) => ({
            label: path.split("/").filter(Boolean).pop() ?? "Dolgate",
            path,
            readOnly: path.endsWith("-b"),
          })),
        },
        sessionId,
      );
      return;

    case "certificateCheck": {
      // TOFU 를 사람이 판단하는 자리다. 여기서는 지문을 찍고 받아들인다 — 내 시험용 호스트를
      // 향한 도구이므로. 지문이 예상과 다르면 그 줄이 증거로 남는다.
      const { fingerprint, subject, notAfter } = event.payload;
      console.log(
        `[probe] certificate ${fingerprint} subject=${subject} notAfter=${notAfter} → accept`,
      );
      request("rdpTrustCertificate", { accept: true }, event.sessionId);
      return;
    }

    case "connected": {
      const { desktopWidth, desktopHeight, monitors: placements } =
        event.payload;
      console.log(
        `[probe] connected ${desktopWidth}x${desktopHeight}`,
        `placements ${placements.map((m) => `${m.width}x${m.height}@(${m.left},${m.top})`).join(" ")}`,
      );
      schedule();
      return;
    }

    case "resized": {
      const { desktopWidth, desktopHeight, monitors: placements } =
        event.payload;
      console.log(
        `[probe] resized ${desktopWidth}x${desktopHeight}`,
        `placements ${(placements ?? []).map((m) => `${m.width}x${m.height}@(${m.left},${m.top})`).join(" ")}`,
      );
      return;
    }

    case "error":
      console.log(`[probe] error: ${event.payload.message}`);
      return;

    case "closed":
      console.log("[probe] closed");
      finish(0);
      return;

    case "clipboardText":
      console.log(`[probe] clipboard ${event.payload.text.length} chars`);
      return;

    default:
      console.log(`[probe] ${event.type} ${JSON.stringify(event.payload)}`);
  }
}

// ── 시나리오 ────────────────────────────────────────────────────────────────

const timers = [];
function after(ms, action) {
  timers.push(setTimeout(action, ms));
}

function schedule() {
  // 화면이 얼마나 오는지 1초마다 본다. 0 이 계속되면 그리지 못하고 있는 것이다.
  let lastFrames = 0;
  let lastBytes = 0;
  const ticker = setInterval(() => {
    const df = frames - lastFrames;
    const db = frameBytes - lastBytes;
    lastFrames = frames;
    lastBytes = frameBytes;
    console.log(
      `[probe] ${df} frames/s  ${(db / 1024).toFixed(0)} KiB/s  (누적 ${frames})`,
    );
  }, 1000);
  timers.push(ticker);

  if (wantRefresh) {
    after(2000, () => {
      console.log("[probe] requesting a full refresh");
      request("rdpRefresh", {}, sessionId);
    });
  }

  if (layoutSpec && layoutSpec !== true) {
    // 앱이 창을 다 펼친 뒤 하는 일과 같다. 배치를 실측값으로 다시 선언한다.
    after(4000, () => {
      const next = parseMonitors(String(layoutSpec));
      console.log(
        `[probe] re-declaring the layout:`,
        next
          .map(
            (m) =>
              `${m.width}x${m.height}@(${m.left},${m.top})${m.primary ? "*" : ""}`,
          )
          .join(" "),
      );
      request("rdpSetLayout", { monitors: next }, sessionId);
    });
  }

  after(seconds * 1000, () => {
    console.log(`[probe] ${seconds}s 경과 — 끊는다`);
    request("disconnect", {}, sessionId);
    // 서버가 조용하면 닫힘 이벤트를 기다리다 매달릴 수 있다. 상한을 둔다.
    after(3000, () => finish(0));
  });
}

function finish(code) {
  clearTimeout(deadline);
  for (const timer of timers) {
    clearTimeout(timer);
    clearInterval(timer);
  }
  console.log(
    `[probe] 총 ${frames} 프레임 / ${(frameBytes / 1024 / 1024).toFixed(1)} MiB`,
  );
  child.stdin.end();
  child.kill();
  process.exit(code);
}

child.on("exit", (code) => {
  console.log(`[probe] rdp-core exited (${code})`);
  process.exit(code ?? 0);
});

process.on("SIGINT", () => finish(130));
