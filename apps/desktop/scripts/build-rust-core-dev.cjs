// rdp-core·vnc-core(Rust 사이드카)의 **개발용** 빌드.
//
// build-rdp-core.cjs / build-vnc-core.cjs 와 나뉘어 있는 이유가 두 가지다.
//
// 1) 산출물 자리가 다르다. 릴리스 스크립트는 `--target <triple>` 로 빌드해
//    `release/resources/<platform>/<arch>/bin/` 에 복사하는데, 개발 중 실행 경로는 그곳을 보지
//    않는다 — resolveRdpLaunchConfig·resolveVncLaunchConfig 는 패키징되지 않았으면
//    `services/<svc>/target/{release,debug}/<bin>` 만 본다. `--target` 을 주면 산출물이
//    `target/<triple>/release/` 로 들어가서 그 조회가 실패한다. 그래서 여기서는 타깃을 주지 않고
//    호스트 기본 타깃으로 빌드한다.
//
// 2) 플랫폼을 인자로 받지 않는다. 개발 빌드는 언제나 "지금 이 기계" 용이다. 예전에는 npm 스크립트가
//    `darwin universal` 을 하드코딩해 두고 `|| true` 로 실패를 삼켰는데, 그래서 윈도우·리눅스에서는
//    아무것도 만들어지지 않으면서 로그상으로는 성공처럼 보였다.
//
// ssh-core 의 개발 빌드(build-ssh-core-dev.cjs)처럼 지문·락으로 재빌드를 건너뛰지는 않는다.
// cargo 는 변경이 없으면 스스로 즉시 반환하므로 그 장치가 값을 하지 못한다.

const { existsSync } = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SERVICES = {
  "rdp-core": { binary: "rdp-core" },
  "vnc-core": { binary: "vnc-core" },
};

const repoRoot = path.resolve(__dirname, "../../..");

function binaryName(service, platform = process.platform) {
  const base = SERVICES[service].binary;
  return platform === "win32" ? `${base}.exe` : base;
}

/** 개발 중 실행 경로가 실제로 찾는 자리. resolve*LaunchConfig 와 같은 규칙이어야 한다. */
function devBinaryPath(service, { root = repoRoot, platform = process.platform } = {}) {
  return path.join(
    root,
    "services",
    service,
    "target",
    "release",
    binaryName(service, platform),
  );
}

/**
 * 이 실패를 개발 흐름 전체의 실패로 볼지.
 *
 * 원격 화면(RDP·VNC)은 선택 기능이라, 이것 하나 때문에 `npm run dev` 가 막히면 관계없는 작업까지
 * 멈춘다. 그래서 개발 빌드는 실패해도 통과시킨다 — 다만 **조용히 넘기지는 않는다.** 예전의
 * `|| true` 가 정확히 그 문제였다: 아무것도 빌드되지 않았는데 로그에는 아무 흔적이 없어서, 나중에
 * "바이너리를 찾을 수 없다" 는 런타임 오류로만 드러났다.
 */
function reportSkip(service, reason, { logger = console.warn } = {}) {
  logger(
    [
      "",
      `⚠️  ${service} 개발 빌드를 건너뜁니다.`,
      `    이유: ${reason}`,
      `    원격 화면(${service === "rdp-core" ? "RDP" : "VNC"}) 기능은 이 세션에서 동작하지 않습니다.`,
      `    직접 빌드: cd services/${service} && cargo build --release`,
      "",
    ].join("\n"),
  );
}

function runCargo(service, { root = repoRoot, spawnSyncImpl = spawnSync } = {}) {
  return spawnSyncImpl("cargo", ["build", "--release", "--locked"], {
    cwd: path.join(root, "services", service),
    stdio: "inherit",
  });
}

function ensureRustCoreDevBuild(
  service,
  {
    root = repoRoot,
    platform = process.platform,
    runCargoImpl = runCargo,
    existsSyncImpl = existsSync,
    logger = console.warn,
    infoLogger = console.log,
  } = {},
) {
  if (!SERVICES[service]) {
    throw new Error(
      `Unknown Rust sidecar: ${service}. Expected one of ${Object.keys(SERVICES).join(", ")}.`,
    );
  }

  const result = runCargoImpl(service, { root });

  // cargo 가 없는 것과 빌드가 깨진 것은 사람이 할 일이 다르다. 앞은 툴체인을 깔면 되고, 뒤는
  // 코드나 빌드 의존성(vnc-core 의 OpenSSL 은 perl 을 요구한다)을 봐야 한다.
  if (result.error && result.error.code === "ENOENT") {
    reportSkip(service, "Rust 툴체인(cargo)이 없습니다 — https://rustup.rs", { logger });
    return { skipped: true, reason: "no-toolchain" };
  }

  if (result.status !== 0) {
    reportSkip(service, "cargo build 가 실패했습니다(위 출력 참고).", { logger });
    return { skipped: true, reason: "build-failed" };
  }

  const outputPath = devBinaryPath(service, { root, platform });
  if (!existsSyncImpl(outputPath)) {
    reportSkip(service, `빌드는 성공했는데 산출물이 없습니다: ${outputPath}`, { logger });
    return { skipped: true, reason: "missing-output" };
  }

  infoLogger(`Built ${service} dev binary: ${path.relative(root, outputPath)}`);
  return { skipped: false, outputPath };
}

if (require.main === module) {
  const [service] = process.argv.slice(2);
  if (!service) {
    console.error(
      `Usage: node ./scripts/build-rust-core-dev.cjs <${Object.keys(SERVICES).join("|")}>`,
    );
    process.exitCode = 1;
  } else {
    try {
      ensureRustCoreDevBuild(service);
    } catch (error) {
      // 알 수 없는 서비스 이름 같은 우리 쪽 실수는 삼키지 않는다.
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}

module.exports = {
  binaryName,
  devBinaryPath,
  ensureRustCoreDevBuild,
  SERVICES,
};
