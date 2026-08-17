const { _electron: electron } = require("@playwright/test");
const electronPath = require("electron");
const { mkdtemp, mkdir, rm, writeFile } = require("node:fs/promises");
const { spawn, spawnSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const { resolvePackagedAppLaunch } = require("./packaged-app-launch.cjs");

const desktopMainPath = path.resolve(__dirname, "../.vite/build/main.js");

/**
 * 이 테스트가 만든 것들의 정리 목록.
 *
 * **본문의 finally 에서 정리하지 않는다.** finally 에서 던진 오류는 try 의 결과를 덮어써서, 통과한
 * 테스트가 정리 실패로 찍힌다 — Windows 에서 실행 중인 exe 를 지우려다(EPERM) 연결 스펙 5개가
 * 전부 실패로 보였고, 그 오류가 본문 결과를 가려 원인을 찾는 데 시간이 걸렸다. 훅에서 정리하면
 * Playwright 가 그것을 teardown 오류로 따로 보고한다.
 */
const pendingCleanups = [];

/** 정리 하나를 등록한다. 등록 순서의 **역순**으로 실행된다(앱을 닫은 뒤 데이터 디렉터리를 지운다). */
function trackCleanup(dispose) {
  pendingCleanups.push(dispose);
}

/**
 * 등록된 정리를 모두 실행한다. 스펙마다 `test.afterEach(drainCleanups)` 로 걸어 준다.
 *
 * 하나가 실패해도 나머지를 **끝까지** 시도한 뒤 한꺼번에 알린다 — 먼저 실패한 것 때문에 프로세스가
 * 남으면 다음 테스트가 그 영향을 받는다.
 */
async function drainCleanups() {
  const failures = [];
  for (const dispose of pendingCleanups.splice(0).reverse()) {
    try {
      await dispose();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "테스트 정리에 실패했다");
  }
}

/**
 * 픽스처 디렉터리를 지운다.
 *
 * **Windows 는 실행 중인 exe 를 지울 수 없다**(EPERM). 프로세스가 끝난 직후에도 백신·인덱서가
 * 잠깐 잡고 있을 수 있어서 재시도를 둔다 — macOS·Linux 는 실행 중에도 unlink 가 되므로 이 규칙이
 * 없어도 통과했고, 그래서 이 함정은 Windows 에서만 드러났다.
 */
async function removeFixtureDir(dir) {
  if (!dir) {
    return;
  }
  await rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 50,
  });
}

/** 프로세스를 끝내고 **실제로 끝나기를** 기다린다. kill 은 신호만 보내고 곧바로 돌아온다. */
async function killAndWait(child, timeoutMs = 5_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  const settled = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
  if (!settled) {
    // 신호를 무시했다. Windows 에서는 둘 다 TerminateProcess 지만, 그 밖에서는 이것이 마지막 수단이다.
    child.kill("SIGKILL");
    await exited;
  }
}
const timestamp = "2025-01-01T00:00:00.000Z";
const fakeAwsSessionReadyMarker = "READY:FAKE_AWS_SSM";
const smokeAwsProfileId = "aws-profile-smoke-default";

/**
 * 시드 상태를 쓴다.
 *
 * overrides 로 hosts·knownHosts 를 갈아 끼울 수 있다. 연결 시나리오는 가짜 sshd 의 **그때그때
 * 포트**를 가리켜야 하고, "처음 보는 호스트" 를 만들려면 knownHosts 를 비워야 한다.
 */
async function writeDesktopState(userDataDir, overrides = {}) {
  const storageDir = path.join(userDataDir, "storage");
  await mkdir(storageDir, { recursive: true });
  await writeFile(
    path.join(storageDir, "state.json"),
    JSON.stringify(
      applyStateOverrides({
        schemaVersion: 1,
        settings: {
          theme: "system",
          updatedAt: timestamp,
        },
        terminal: {
          globalThemeId: "dolssh-dark",
          globalThemeUpdatedAt: timestamp,
          fontFamily: "sf-mono",
          fontSize: 13,
          autocompleteEnabled: false,
          localUpdatedAt: timestamp,
        },
        updater: {
          dismissedVersion: null,
          updatedAt: timestamp,
        },
        auth: {
          status: "authenticated",
          updatedAt: timestamp,
        },
        sync: {
          lastSuccessfulSyncAt: null,
          pendingPush: false,
          errorMessage: null,
          updatedAt: timestamp,
        },
        data: {
          groups: [
            {
              id: "group-1",
              name: "Production",
              path: "Production",
              parentPath: null,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ],
          hosts: [
            {
              id: "aws-1",
              kind: "aws-ec2",
              label: "Smoke AWS",
              awsProfileId: smokeAwsProfileId,
              awsProfileName: "default",
              awsRegion: "ap-northeast-2",
              awsInstanceId: "i-smoke-test",
              awsAvailabilityZone: "ap-northeast-2a",
              awsInstanceName: "smoke",
              awsPlatform: "linux",
              awsPrivateIp: "10.0.0.10",
              awsState: "running",
              awsSshUsername: "ubuntu",
              awsSshPort: 22,
              groupName: "Production",
              tags: ["smoke"],
              terminalThemeId: null,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
            {
              id: "ssh-1",
              kind: "ssh",
              label: "Smoke SSH",
              hostname: "prod.example.com",
              port: 22,
              username: "ubuntu",
              authType: "password",
              privateKeyPath: null,
              secretRef: null,
              groupName: "Production",
              tags: ["smoke"],
              terminalThemeId: null,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ],
          // EC2(aws-ec2) 연결은 이제 SSH 호스트와 동일하게 연결 전 호스트 키 신뢰를 요구한다.
          // 스모크는 "이미 신뢰한 호스트" 정상 상태를 재현하므로 Smoke AWS의 SSM 호스트 키를
          // 미리 신뢰 목록에 심어, 연결 시 신뢰 프롬프트 없이 바로 진행되게 한다.
          knownHosts: [
            {
              id: "known-aws-smoke",
              host: "aws-ssm:default:ap-northeast-2:i-smoke-test",
              port: 22,
              algorithm: "ssh-ed25519",
              publicKeyBase64:
                "AAAAC3NzaC1lZDI1NTE5AAAAIE2ESmokeTestKeyDoNotUseAnywhereElse00",
              fingerprintSha256:
                "SHA256:E2ESmokeTestFingerprintDoNotUseAnywhereElse0000",
              createdAt: timestamp,
              lastSeenAt: timestamp,
              updatedAt: timestamp,
            },
          ],
          portForwards: [],
          secretMetadata: [],
          awsProfiles: [
            {
              id: smokeAwsProfileId,
              name: "default",
              kind: "static",
              updatedAt: timestamp,
            },
          ],
          syncOutbox: [],
        },
        secure: {
          refreshToken: null,
          managedSecretsByRef: {},
        },
      }, overrides),
      null,
      2,
    ),
    "utf8",
  );
}

function createFakeAuthSessionJson() {
  return JSON.stringify({
    user: {
      id: "user-smoke",
      email: "smoke@example.com",
    },
    tokens: {
      accessToken: "smoke-access-token",
      refreshToken: "smoke-refresh-token",
      expiresInSeconds: 900,
    },
    vaultBootstrap: {
      keyBase64: Buffer.alloc(32, 1).toString("base64"),
    },
    syncServerTime: timestamp,
  });
}

/**
 * 시드 상태에 덮어쓸 것을 얹는다.
 *
 * data 안쪽(hosts·knownHosts)만 갈아 끼우고 나머지는 그대로 둔다 — 인증·설정까지 시나리오마다
 * 다시 쓰게 하면 기존 스모크가 의존하는 값을 하나씩 빠뜨린다.
 */
function applyStateOverrides(state, overrides) {
  if (!overrides || Object.keys(overrides).length === 0) {
    return state;
  }
  return {
    ...state,
    data: {
      ...state.data,
      ...(overrides.hosts ? { hosts: overrides.hosts } : {}),
      ...(overrides.knownHosts ? { knownHosts: overrides.knownHosts } : {}),
      ...(overrides.portForwards ? { portForwards: overrides.portForwards } : {}),
    },
  };
}

/**
 * 가짜 sshd 를 띄운다. 진짜 서버 없이 연결 화면을 검증하기 위한 것이다.
 *
 * 포트는 매번 OS 가 고르고, 호스트 키도 기동마다 새로 만든다 — 그래서 호출부가 그 값을 받아
 * 호스트를 시드한다. "처음 보는 호스트" 를 만들려면 그 키를 knownHosts 에 심지 않으면 된다.
 */
async function startFakeSshd(options = {}) {
  const fixtureRoot = await mkdtemp(
    path.join(os.tmpdir(), "dolssh-sshd-fixture-"),
  );
  const fixturePath = path.join(
    fixtureRoot,
    process.platform === "win32" ? "fake-sshd.exe" : "fake-sshd",
  );
  const fixtureSourceDir = path.resolve(
    __dirname,
    "../../../services/ssh-core/internal/sshconn/testfixture",
  );
  const build = spawnSync("go", ["build", "-o", fixturePath, "."], {
    cwd: fixtureSourceDir,
    encoding: "utf8",
  });
  if (build.error || build.status !== 0) {
    throw new Error(
      `failed to build fake sshd: ${[build.error?.message, build.stdout, build.stderr]
        .filter(Boolean)
        .join("\n")}`,
    );
  }

  const args = [];
  if (options.user) args.push("-user", options.user);
  if (options.password !== undefined) args.push("-password", options.password);
  if (options.otp) args.push("-otp", options.otp);
  if (options.banner) args.push("-banner", options.banner);
  if (options.relay) args.push("-relay");

  const child = spawn(fixturePath, args, { stdio: ["ignore", "pipe", "pipe"] });
  const announced = await new Promise((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(
      () => reject(new Error(`fake sshd did not announce itself: ${buffered}`)),
      15_000,
    );
    child.stdout.on("data", (chunk) => {
      buffered += String(chunk);
      const address = /LISTENING (\S+)/.exec(buffered);
      const hostKey = /HOSTKEY (\S+)/.exec(buffered);
      if (address && hostKey) {
        clearTimeout(timer);
        resolve({ address: address[1], hostKey: hostKey[1] });
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`fake sshd exited early (${code}): ${buffered}`));
    });
  });

  const [host, portText] = announced.address.split(":");
  // 정리를 호출부에 맡기지 않는다. 잊으면 프로세스와 디렉터리가 남고, 그 사실은 다음 실행에서야
  // 드러난다. stop() 은 여러 번 불려도 안전하다(끝난 프로세스는 그냥 지나가고 삭제는 force 다).
  trackCleanup(() => stopFakeSshd());
  async function stopFakeSshd() {
    // 순서가 계약이다. 지우기 전에 프로세스가 끝나야 한다 — Windows 는 실행 중인 exe 를 지울 수
    // 없다(EPERM). macOS·Linux 는 실행 중에도 unlink 가 되므로 이 함정은 Windows 에서만 드러났다.
    await killAndWait(child);
    await removeFixtureDir(fixtureRoot);
  }

  return {
    host,
    port: Number(portText),
    hostKeyBase64: announced.hostKey,
    stop: stopFakeSshd,
  };
}

/**
 * 가짜 sshd 를 가리키는 SSH 호스트를 **앱의 실제 저장 경로로** 만든다.
 *
 * state.json 에 심지 않는 이유: 비밀번호는 상태 파일이 아니라 OS 키체인에 들어간다. 심어 놓기만
 * 하면 연결이 "password auth requires a password" 로 그 자리에서 끝난다. 사용자가 호스트를
 * 만들 때 지나는 IPC 를 그대로 불러 자격증명까지 함께 저장한다.
 *
 * 만든 뒤 창을 다시 읽는다 — 스토어는 부팅 때 목록을 받으므로 그래야 카드가 보인다.
 */
async function createSshHostWithPassword(page, sshd, overrides = {}) {
  const draft = {
    kind: "ssh",
    label: "Fake SSHD",
    hostname: sshd.host,
    port: sshd.port,
    username: "ubuntu",
    authType: "password",
    groupName: null,
    tags: [],
    terminalThemeId: null,
    ...overrides,
  };
  const created = await page.evaluate(
    async ([hostDraft, password]) => {
      const record = await window.dolssh.hosts.create(hostDraft, { password });
      return record && typeof record === "object" ? { id: record.id } : null;
    },
    [draft, "pw"],
  );
  await page.reload();
  // 점프 체인은 호스트 **id** 로 엮이므로 만든 것의 id 를 돌려준다.
  return { ...draft, id: created?.id ?? null };
}

/** 가짜 sshd 를 가리키는 SSH 호스트 하나. */
function fakeSshHost(sshd, overrides = {}) {
  return {
    id: "ssh-fake",
    kind: "ssh",
    label: "Fake SSHD",
    hostname: sshd.host,
    port: sshd.port,
    username: "ubuntu",
    authType: "password",
    privateKeyPath: null,
    secretRef: null,
    groupName: null,
    tags: [],
    terminalThemeId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

async function launchDesktop(env) {
  const e2eDefaultEnv = {
    DOLSSH_E2E_ALLOW_MULTI_INSTANCE:
      process.env.DOLSSH_E2E_ALLOW_MULTI_INSTANCE ?? "1",
  };
  const mergedEnv = Object.fromEntries(
    Object.entries({
      ...process.env,
      ...e2eDefaultEnv,
      ...env,
    }).filter((entry) => typeof entry[1] === "string"),
  );

  if (process.env.DOLSSH_E2E_USE_PACKAGED_APP === "1") {
    const packagedLaunch = resolvePackagedAppLaunch({
      override: process.env.DOLSSH_E2E_PACKAGED_APP_ENTRY,
      electronPath,
      outDir: path.resolve(__dirname, "../out"),
      platform: process.platform,
      arch: process.arch,
      targetPlatform: process.env.DOLSSH_TARGET_PLATFORM,
      targetArch: process.env.DOLSSH_TARGET_ARCH,
    });
    return electron.launch({
      executablePath: packagedLaunch.executablePath,
      args: packagedLaunch.args,
      env: mergedEnv,
    });
  }

  return electron.launch({
    executablePath: electronPath,
    args: [desktopMainPath],
    env: mergedEnv,
  });
}

async function buildAwsFixture() {
  const fixtureRoot = await mkdtemp(
    path.join(os.tmpdir(), "dolssh-aws-fixture-"),
  );
  const fixturePath = path.join(
    fixtureRoot,
    process.platform === "win32" ? "fake-aws-session.exe" : "fake-aws-session",
  );
  const fixtureSourceDir = path.resolve(
    __dirname,
    "../../../services/ssh-core/internal/awssession/testfixture",
  );
  const result = spawnSync("go", ["build", "-o", fixturePath, "."], {
    cwd: fixtureSourceDir,
    encoding: "utf8",
  });

  if (result.error || result.status !== 0) {
    const stderr = [result.error?.message, result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n");
    throw new Error(`failed to build Windows AWS fixture: ${stderr}`);
  }

  trackCleanup(() => removeFixtureDir(fixtureRoot));
  return {
    fixtureRoot,
    fixturePath,
  };
}

async function waitForCapturedTerminalOutput(page, expected, timeout = 15_000) {
  await page.waitForFunction(
    (needle) => {
      const e2e = window.__dolsshE2E;
      if (!e2e || typeof e2e.getTerminalOutputs !== "function") {
        return false;
      }

      return Object.values(e2e.getTerminalOutputs()).some((output) =>
        output.includes(needle),
      );
    },
    expected,
    { timeout },
  );
}

async function waitForTerminalInputReady(page, timeout = 15_000) {
  await page.waitForFunction(
    () => {
      const container = document.querySelector('[data-terminal-canvas="true"]');
      if (!(container instanceof HTMLElement)) {
        return false;
      }

      const overlay = container.querySelector('[role="status"], [role="alertdialog"]');
      if (!(overlay instanceof HTMLElement)) {
        return true;
      }

      return overlay.getAttribute("aria-label") === "Connected";
    },
    { timeout },
  );
}

async function waitForFakeAwsSessionReady(page, timeout = 15_000) {
  await waitForCapturedTerminalOutput(page, fakeAwsSessionReadyMarker, timeout);
}

async function getCapturedSessionId(page) {
  const handle = await page.waitForFunction(
    () => {
      const e2e = window.__dolsshE2E;
      if (!e2e || typeof e2e.getTerminalOutputs !== "function") {
        return null;
      }

      return Object.keys(e2e.getTerminalOutputs())[0] ?? null;
    },
    { timeout: 15_000 },
  );
  const sessionId = await handle.jsonValue();
  await handle.dispose();

  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("failed to capture active session id");
  }

  return sessionId;
}

async function getCapturedTerminalSizes(page) {
  return page.evaluate(() => {
    const e2e = window.__dolsshE2E;
    if (!e2e || typeof e2e.getTerminalOutputs !== "function") {
      return [];
    }

    return Object.values(e2e.getTerminalOutputs()).flatMap((output) =>
      Array.from(output.matchAll(/SIZE:(\d+)x(\d+)/g), (match) => ({
        cols: Number(match[1]),
        rows: Number(match[2]),
      })),
    );
  });
}

async function getSessionTerminalState(page, sessionId) {
  return page.evaluate((targetSessionId) => {
    const e2e = window.__dolsshE2E;
    if (!e2e || typeof e2e.getSessionTerminalState !== "function") {
      return null;
    }

    return e2e.getSessionTerminalState(targetSessionId);
  }, sessionId);
}

async function waitForSessionTerminalState(
  page,
  sessionId,
  expectation = {},
  timeout = 15_000,
) {
  const handle = await page.waitForFunction(
    (input) => {
      const e2e = window.__dolsshE2E;
      if (!e2e || typeof e2e.getSessionTerminalState !== "function") {
        return null;
      }

      const state = e2e.getSessionTerminalState(input.sessionId);
      if (!state) {
        return null;
      }

      if (
        typeof input.hasOutput === "boolean" &&
        state.hasOutput !== input.hasOutput
      ) {
        return null;
      }
      if (
        typeof input.includesText === "string" &&
        (typeof state.snapshot !== "string" ||
          !state.snapshot.includes(input.includesText))
      ) {
        return null;
      }
      if (
        typeof input.minCols === "number" &&
        (typeof state.cols !== "number" || state.cols < input.minCols)
      ) {
        return null;
      }
      if (
        typeof input.minRows === "number" &&
        (typeof state.rows !== "number" || state.rows < input.minRows)
      ) {
        return null;
      }

      return state;
    },
    { sessionId, ...expectation },
    { timeout },
  );
  const state = await handle.jsonValue();
  await handle.dispose();
  return state;
}

async function waitForReplayState(page, expectation = {}, timeout = 15_000) {
  const handle = await page.waitForFunction(
    (inputExpectation) => {
      const e2e = window.__dolsshE2E;
      if (!e2e || typeof e2e.getReplayState !== "function") {
        return null;
      }
      const state = e2e.getReplayState();
      if (!state) {
        return null;
      }

      if (
        typeof inputExpectation.isPlaying === "boolean" &&
        state.isPlaying !== inputExpectation.isPlaying
      ) {
        return null;
      }
      if (
        typeof inputExpectation.zoomPercent === "number" &&
        state.zoomPercent !== inputExpectation.zoomPercent
      ) {
        return null;
      }
      if (
        typeof inputExpectation.minPositionMs === "number" &&
        typeof state.positionMs === "number" &&
        state.positionMs < inputExpectation.minPositionMs
      ) {
        return null;
      }
      if (
        typeof inputExpectation.maxPositionMs === "number" &&
        typeof state.positionMs === "number" &&
        state.positionMs > inputExpectation.maxPositionMs
      ) {
        return null;
      }
      if (
        typeof inputExpectation.includesText === "string" &&
        (typeof state.terminalText !== "string" ||
          !state.terminalText.includes(inputExpectation.includesText))
      ) {
        return null;
      }
      if (
        inputExpectation.requireDuration === true &&
        (!(typeof state.durationMs === "number") || state.durationMs <= 0)
      ) {
        return null;
      }

      return state;
    },
    expectation,
    { timeout },
  );
  const state = await handle.jsonValue();
  await handle.dispose();
  return state;
}

module.exports = {
  buildAwsFixture,
  startFakeSshd,
  fakeSshHost,
  createSshHostWithPassword,
  createFakeAuthSessionJson,
  fakeAwsSessionReadyMarker,
  getCapturedSessionId,
  getSessionTerminalState,
  getCapturedTerminalSizes,
  launchDesktop,
  killAndWait,
  removeFixtureDir,
  trackCleanup,
  drainCleanups,
  waitForSessionTerminalState,
  waitForTerminalInputReady,
  waitForCapturedTerminalOutput,
  waitForFakeAwsSessionReady,
  waitForReplayState,
  writeDesktopState,
  rm,
  mkdtemp,
  os,
  path,
};
