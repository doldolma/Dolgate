const { _electron: electron } = require("@playwright/test");
const electronPath = require("electron");
const { mkdtemp, mkdir, rm, writeFile } = require("node:fs/promises");
const { spawnSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const { resolvePackagedAppLaunch } = require("./packaged-app-launch.cjs");

const desktopMainPath = path.resolve(__dirname, "../.vite/build/main.js");
const timestamp = "2025-01-01T00:00:00.000Z";
const fakeAwsSessionReadyMarker = "READY:FAKE_AWS_SSM";

async function writeDesktopState(userDataDir) {
  const storageDir = path.join(userDataDir, "storage");
  await mkdir(storageDir, { recursive: true });
  await writeFile(
    path.join(storageDir, "state.json"),
    JSON.stringify(
      {
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
          knownHosts: [],
          portForwards: [],
          secretMetadata: [],
          syncOutbox: [],
        },
        secure: {
          refreshToken: null,
          managedSecretsByRef: {},
        },
      },
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
  createFakeAuthSessionJson,
  fakeAwsSessionReadyMarker,
  getCapturedSessionId,
  getSessionTerminalState,
  getCapturedTerminalSizes,
  launchDesktop,
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
