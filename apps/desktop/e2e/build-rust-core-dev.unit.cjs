const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  binaryName,
  devBinaryPath,
  ensureRustCoreDevBuild,
} = require("../scripts/build-rust-core-dev.cjs");

// 개발 빌드가 실제로 쓰이려면 산출물 자리가 resolve*LaunchConfig 와 같아야 한다. 그쪽은
// `services/<svc>/target/{release,debug}/<bin>` 만 보므로, `--target <triple>` 을 붙이는 릴리스
// 규칙(`target/<triple>/release/`)과 섞이면 빌드는 되는데 앱이 못 찾는다 — 실제로 그랬다.
test("dev binary path matches what the app looks for", () => {
  const root = path.join(path.sep, "repo");

  assert.equal(
    devBinaryPath("rdp-core", { root, platform: "win32" }),
    path.join(root, "services", "rdp-core", "target", "release", "rdp-core.exe"),
  );
  assert.equal(
    devBinaryPath("vnc-core", { root, platform: "darwin" }),
    path.join(root, "services", "vnc-core", "target", "release", "vnc-core"),
  );
});

test("binary name gets the .exe suffix only on Windows", () => {
  assert.equal(binaryName("rdp-core", "win32"), "rdp-core.exe");
  assert.equal(binaryName("rdp-core", "linux"), "rdp-core");
});

// 플랫폼을 인자로 받지 않는다. 예전 npm 스크립트는 `darwin universal` 을 하드코딩해서 윈도우·리눅스
// 에서는 아무것도 만들지 못했다.
test("builds for the host without a target triple", () => {
  const calls = [];
  const result = ensureRustCoreDevBuild("rdp-core", {
    root: path.join(path.sep, "repo"),
    platform: "win32",
    runCargoImpl: (service, options) => {
      calls.push({ service, options });
      return { status: 0 };
    },
    existsSyncImpl: () => true,
    infoLogger: () => {},
  });

  assert.equal(result.skipped, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].service, "rdp-core");
});

// 원격 화면은 선택 기능이라 실패가 dev 전체를 막지는 않는다. 대신 **반드시 눈에 보여야** 한다 —
// 예전 `|| true` 는 아무 흔적 없이 넘겨서, 나중에 런타임 오류로만 드러났다.
test("a missing toolchain is a loud skip, not a silent one", () => {
  const warnings = [];
  const result = ensureRustCoreDevBuild("vnc-core", {
    runCargoImpl: () => ({ error: Object.assign(new Error("nope"), { code: "ENOENT" }) }),
    existsSyncImpl: () => false,
    logger: (message) => warnings.push(message),
  });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, "no-toolchain");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /vnc-core/);
  assert.match(warnings[0], /rustup\.rs/);
});

test("a failed build is reported separately from a missing toolchain", () => {
  const warnings = [];
  const result = ensureRustCoreDevBuild("vnc-core", {
    runCargoImpl: () => ({ status: 101 }),
    existsSyncImpl: () => false,
    logger: (message) => warnings.push(message),
  });

  assert.equal(result.reason, "build-failed");
  assert.match(warnings[0], /cargo build/);
});

// 빌드가 성공했다고 보고했는데 산출물이 없으면 그것도 드러내야 한다. 조용히 통과하면 앱이 기동한
// 뒤에야 "바이너리를 찾을 수 없다" 로 나타난다.
test("a successful build with no artifact is still reported", () => {
  const warnings = [];
  const result = ensureRustCoreDevBuild("rdp-core", {
    runCargoImpl: () => ({ status: 0 }),
    existsSyncImpl: () => false,
    logger: (message) => warnings.push(message),
  });

  assert.equal(result.reason, "missing-output");
  assert.equal(warnings.length, 1);
});

test("an unknown sidecar name is our own mistake and throws", () => {
  assert.throws(() => ensureRustCoreDevBuild("ssh-core", { runCargoImpl: () => ({ status: 0 }) }), /Unknown Rust sidecar/);
});
