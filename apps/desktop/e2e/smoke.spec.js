const { test, expect, _electron: electron } = require("@playwright/test");
const electronPath = require("electron");
const { mkdtemp, mkdir, rm, writeFile } = require("node:fs/promises");
const { spawnSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");

const desktopMainPath = path.resolve(__dirname, "../.vite/build/main.js");
const timestamp = "2025-01-01T00:00:00.000Z";

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
              awsInstanceName: "smoke",
              awsPlatform: "linux",
              awsPrivateIp: "10.0.0.10",
              awsState: "running",
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
  const mergedEnv = Object.fromEntries(
    Object.entries({
      ...process.env,
      ...env,
    }).filter((entry) => typeof entry[1] === "string"),
  );

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

test.describe("desktop smoke", () => {
  test("shows the login gate when no session is bootstrapped", async () => {
    const userDataDir = await mkdtemp(
      path.join(os.tmpdir(), "dolssh-smoke-login-"),
    );
    const app = await launchDesktop({
      DOLSSH_USER_DATA_DIR: userDataDir,
    });

    try {
      const page = await app.firstWindow();
      await expect(
        page.getByRole("button", { name: "브라우저로 로그인하기" }),
      ).toBeVisible();
    } finally {
      await app.close();
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("boots into home, switches sections, and renders the SFTP workspace", async () => {
    const userDataDir = await mkdtemp(
      path.join(os.tmpdir(), "dolssh-smoke-home-"),
    );
    await writeDesktopState(userDataDir);

    const app = await launchDesktop({
      DOLSSH_USER_DATA_DIR: userDataDir,
      DOLSSH_E2E_AUTH_SESSION_JSON: createFakeAuthSessionJson(),
      DOLSSH_E2E_DISABLE_SYNC: "1",
      DOLSSH_E2E_FAKE_AWS_SESSION: "1",
    });

    try {
      const page = await app.firstWindow();
      const homeNavigation = page.getByRole("navigation", {
        name: "Home navigation",
      });

      await expect(
        homeNavigation.getByRole("button", { name: "▣ Hosts" }),
      ).toBeVisible();
      await expect(page.getByText("Smoke AWS")).toBeVisible();

      await homeNavigation
        .getByRole("button", { name: "⇄ Port Forwarding" })
        .click();
      await expect(
        page.getByRole("heading", { name: "Port Forwarding" }),
      ).toBeVisible();

      await homeNavigation.getByRole("button", { name: "◌ Settings" }).click();
      await expect(
        page.getByRole("heading", { name: "Settings" }),
      ).toBeVisible();

      await homeNavigation.getByRole("button", { name: "▣ Hosts" }).click();
      await expect(
        page
          .locator(".host-browser-card")
          .filter({ hasText: "Smoke AWS" })
          .first(),
      ).toBeVisible();

      await page.getByRole("button", { name: "SFTP" }).click();
      await expect(
        page.getByRole("heading", { name: "Host", exact: true }),
      ).toBeVisible();
      await expect(page.getByPlaceholder("Search hosts...")).toBeVisible();
      await expect(
        page
          .locator(".sftp-host-picker .group-card")
          .filter({ hasText: "Production" })
          .first(),
      ).toBeVisible();
      await page
        .locator(".sftp-host-picker .group-card")
        .filter({ hasText: "Production" })
        .first()
        .click();
      await expect(
        page
          .locator(".sftp-host-picker .host-browser-card")
          .filter({ hasText: "Smoke SSH" })
          .first(),
      ).toBeVisible();
    } finally {
      await app.close();
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("opens a working local terminal from the TERMINAL button on Windows", async () => {
    test.skip(process.platform !== "win32", "Windows-only local terminal smoke");

    const userDataDir = await mkdtemp(
      path.join(os.tmpdir(), "dolssh-smoke-local-"),
    );
    await writeDesktopState(userDataDir);

    const app = await launchDesktop({
      DOLSSH_USER_DATA_DIR: userDataDir,
      DOLSSH_E2E_AUTH_SESSION_JSON: createFakeAuthSessionJson(),
      DOLSSH_E2E_DISABLE_SYNC: "1",
      DOLSSH_E2E_CAPTURE_TERMINAL: "1",
    });

    try {
      const page = await app.firstWindow();
      const terminalButton = page.getByRole("button", { name: "TERMINAL" });

      await expect(terminalButton).toBeVisible();
      await terminalButton.click();
      await expect(
        page.locator(".terminal-session.active .terminal-canvas"),
      ).toBeVisible();

      await page.locator(".terminal-session.active .terminal-canvas").click();
      await page.keyboard.type("echo READY_FROM_LOCAL_SMOKE");
      await page.keyboard.press("Enter");

      await page.waitForFunction(
        () => {
          const e2e = window.__dolsshE2E;
          if (!e2e || typeof e2e.getTerminalOutputs !== "function") {
            return false;
          }

          return Object.values(e2e.getTerminalOutputs()).some((output) =>
            output.includes("READY_FROM_LOCAL_SMOKE"),
          );
        },
        { timeout: 15_000 },
      );
    } finally {
      await app.close();
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("renders process-backed fake AWS SSM output inside the app terminal", async () => {
    const userDataDir = await mkdtemp(
      path.join(os.tmpdir(), "dolssh-smoke-aws-"),
    );
    await writeDesktopState(userDataDir);
    const fixture = await buildAwsFixture();

    const app = await launchDesktop({
      DOLSSH_USER_DATA_DIR: userDataDir,
      DOLSSH_E2E_AUTH_SESSION_JSON: createFakeAuthSessionJson(),
      DOLSSH_E2E_DISABLE_SYNC: "1",
      DOLSSH_E2E_FAKE_AWS_SESSION: "process",
      DOLSSH_E2E_CAPTURE_TERMINAL: "1",
      DOLSSH_E2E_FAKE_AWS_FIXTURE_PATH: fixture.fixturePath,
    });

    try {
      const page = await app.firstWindow();
      await app.evaluate(({ BrowserWindow }) => {
        const [window] = BrowserWindow.getAllWindows();
        window?.setSize(1100, 760);
      });
      await page.waitForFunction(() => window.innerWidth <= 1100, {
        timeout: 15_000,
      });

      const awsCard = page
        .locator(".host-browser-card")
        .filter({ hasText: "Smoke AWS" })
        .first();

      await expect(awsCard).toBeVisible();
      await awsCard.dblclick();
      await waitForCapturedTerminalOutput(page, "TTY:");
      await page.waitForFunction(() => {
        const e2e = window.__dolsshE2E;
        if (!e2e || typeof e2e.getTerminalOutputs !== "function") {
          return false;
        }

        return Object.values(e2e.getTerminalOutputs()).some((output) =>
          /SIZE:\d+x\d+/.test(output),
        );
      }, { timeout: 15_000 });

      const initialSizes = await getCapturedTerminalSizes(page);
      const initialSize = initialSizes.at(-1);
      expect(initialSize).toBeTruthy();

      await page.locator(".terminal-session.active .terminal-canvas").click();
      await page.keyboard.type("hello-from-playwright");
      await page.keyboard.press("Enter");
      await waitForCapturedTerminalOutput(page, "ECHO:hello-from-playwright");

      await app.evaluate(({ BrowserWindow }) => {
        const [window] = BrowserWindow.getAllWindows();
        window?.setSize(1500, 1000);
      });
      await page.waitForFunction(() => window.innerWidth >= 1200, {
        timeout: 15_000,
      });
      await page.waitForTimeout(300);

      await page.locator(".terminal-session.active .terminal-canvas").click();
      await page.keyboard.type("__REPORT_SIZE__");
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        (expectedSize) => {
          const e2e = window.__dolsshE2E;
          if (!e2e || typeof e2e.getTerminalOutputs !== "function") {
            return false;
          }

          const sizes = Object.values(e2e.getTerminalOutputs()).flatMap(
            (output) =>
              Array.from(output.matchAll(/SIZE:(\d+)x(\d+)/g), (match) => ({
                cols: Number(match[1]),
                rows: Number(match[2]),
              })),
          );

          return sizes.some(
            (size) =>
              size.cols !== expectedSize.cols || size.rows !== expectedSize.rows,
          );
        },
        initialSize,
        { timeout: 15_000 },
      );

      const terminalSizes = await getCapturedTerminalSizes(page);
      const resizedSize = [...terminalSizes]
        .reverse()
        .find(
          (size) =>
            size.cols !== initialSize.cols || size.rows !== initialSize.rows,
        );

      expect(resizedSize).toBeTruthy();
      expect(
        resizedSize.cols > initialSize.cols ||
          resizedSize.rows > initialSize.rows,
      ).toBe(true);
    } finally {
      await app.close();
      await rm(userDataDir, { recursive: true, force: true });
      await rm(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });

  test("starts and stops a fake shared session and keeps owner chat flowing into the detached window", async () => {
    const userDataDir = await mkdtemp(
      path.join(os.tmpdir(), "dolssh-smoke-share-"),
    );
    await writeDesktopState(userDataDir);
    const fixture = await buildAwsFixture();

    const app = await launchDesktop({
      DOLSSH_USER_DATA_DIR: userDataDir,
      DOLSSH_E2E_AUTH_SESSION_JSON: createFakeAuthSessionJson(),
      DOLSSH_E2E_DISABLE_SYNC: "1",
      DOLSSH_E2E_FAKE_AWS_SESSION: "process",
      DOLSSH_E2E_CAPTURE_TERMINAL: "1",
      DOLSSH_E2E_FAKE_AWS_FIXTURE_PATH: fixture.fixturePath,
      DOLSSH_E2E_FAKE_SESSION_SHARE: "1",
    });

    try {
      const page = await app.firstWindow();
      const awsCard = page
        .locator(".host-browser-card")
        .filter({ hasText: "Smoke AWS" })
        .first();

      await expect(awsCard).toBeVisible();
      await awsCard.dblclick();
      await waitForCapturedTerminalOutput(page, "TTY:");

      const sessionId = await getCapturedSessionId(page);

      await page.getByRole("button", { name: "Share" }).click();
      await page.getByRole("button", { name: "공유 시작" }).click();

      await expect(page.getByText("공유 링크가 준비되었습니다.")).toBeVisible();
      await expect(page.locator(".terminal-share-popover__url-text")).toContainText(
        `/share/e2e-share-${sessionId}/e2e-viewer-token-${sessionId}`,
      );

      const chatWindowPromise = app.waitForEvent("window");
      await page.getByRole("button", { name: "채팅 기록" }).click();
      const chatWindow = await chatWindowPromise;
      await chatWindow.waitForLoadState("domcontentloaded");
      await expect(chatWindow.getByText("아직 채팅이 없습니다.")).toBeVisible();

      const message = {
        id: "chat-smoke-1",
        nickname: "맑은 다람쥐",
        text: "안녕하세요\n반가워요",
        sentAt: "2026-03-28T10:00:00.000Z",
      };
      await app.evaluate(
        ({ BrowserWindow }, eventPayload) => {
          for (const window of BrowserWindow.getAllWindows()) {
            window.webContents.send("session-shares:chat-event", eventPayload);
          }
        },
        {
          sessionId,
          message,
        },
      );

      await expect(
        page.locator(".terminal-share-chat-toast").filter({ hasText: "안녕하세요" }).first(),
      ).toBeVisible();
      await expect(chatWindow.getByText("안녕하세요")).toBeVisible();
      await expect(chatWindow.getByText("반가워요")).toBeVisible();

      await page.getByRole("button", { name: "공유 종료" }).click();

      await expect.poll(() => chatWindow.isClosed()).toBe(true);
    } finally {
      await app.close();
      await rm(userDataDir, { recursive: true, force: true });
      await rm(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });
});
