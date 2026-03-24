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

async function buildWindowsAwsFixture() {
  const fixtureRoot = await mkdtemp(
    path.join(os.tmpdir(), "dolssh-aws-fixture-"),
  );
  const fixturePath = path.join(fixtureRoot, "fake-aws-session.exe");
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

  test("renders process-backed fake AWS SSM output inside the app terminal on Windows", async () => {
    test.skip(process.platform !== "win32", "Windows-only ConPTY smoke");

    const userDataDir = await mkdtemp(
      path.join(os.tmpdir(), "dolssh-smoke-aws-"),
    );
    await writeDesktopState(userDataDir);
    const fixture = await buildWindowsAwsFixture();

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
      await page.waitForFunction(
        () => {
          const e2e = window.__dolsshE2E;
          if (!e2e || typeof e2e.getTerminalOutputs !== "function") {
            return false;
          }

          return Object.values(e2e.getTerminalOutputs()).some((output) =>
            output.includes("FAKE AWS SSM READY"),
          );
        },
        { timeout: 15_000 },
      );
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
      await page.waitForFunction(
        () => {
          const e2e = window.__dolsshE2E;
          if (!e2e || typeof e2e.getTerminalOutputs !== "function") {
            return false;
          }

          return Object.values(e2e.getTerminalOutputs()).some((output) =>
            output.includes("ECHO:hello-from-playwright"),
          );
        },
        { timeout: 15_000 },
      );

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
});
