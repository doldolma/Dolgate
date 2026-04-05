const { test, expect } = require("@playwright/test");
const {
  buildAwsFixture,
  createFakeAuthSessionJson,
  launchDesktop,
  mkdtemp,
  os,
  path,
  rm,
  waitForCapturedTerminalOutput,
  waitForFakeAwsSessionReady,
  waitForReplayState,
  writeDesktopState,
} = require("./helpers");

async function seekReplay(page, nextPositionMs) {
  await page.getByLabel("Replay scrubber").evaluate((element, value) => {
    const input = element;
    const descriptor = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    );
    descriptor?.set?.call(input, String(value));
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }, nextPositionMs);
}

test.describe("desktop replay regression", () => {
  test("records a remote session into Logs and replays it in a detached window", async () => {
    const userDataDir = await mkdtemp(
      path.join(os.tmpdir(), "dolssh-smoke-replay-"),
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
      const awsCard = page
        .locator('[data-host-card="true"]')
        .filter({ hasText: "Smoke AWS" })
        .first();

      await expect(awsCard).toBeVisible();
      await awsCard.dblclick();
      await waitForFakeAwsSessionReady(page);
      await page.locator('[data-terminal-canvas="true"]').click();
      await page.keyboard.type("replay-smoke-check");
      await page.keyboard.press("Enter");
      await waitForCapturedTerminalOutput(page, "ECHO:replay-smoke-check");

      await page.getByRole("button", { name: /Smoke AWS 세션 종료/ }).click();

      await page
        .getByRole("navigation", { name: "Home navigation" })
        .getByRole("button", { name: "☰ Logs" })
        .click();

      await expect(page.getByRole("heading", { name: "Logs" })).toBeVisible();
      await expect(page.getByTestId("logs-lifecycle-card").filter({ hasText: "Smoke AWS" }).first()).toBeVisible();
      await expect(page.getByText("AWS SSM")).toBeVisible();
      await expect(page.getByText("default · ap-northeast-2 · i-smoke-test")).toBeVisible();
      await expect(page.getByText("Closed")).toBeVisible();

      const replayWindowPromise = app.waitForEvent("window");
      await page.getByRole("button", { name: "Replay" }).click();
      const replayWindow = await replayWindowPromise;
      await replayWindow.waitForLoadState("domcontentloaded");

      const initialReplayState = await waitForReplayState(
        replayWindow,
        {
          isPlaying: true,
          includesText: "ECHO:replay-smoke-check",
          requireDuration: true,
        },
      );

      expect(initialReplayState?.durationMs).toBeGreaterThan(0);
      expect(initialReplayState?.terminalText).toContain("ECHO:replay-smoke-check");
      const midSeekMs = Math.max(
        100,
        Math.floor((initialReplayState.durationMs * 0.5) / 100) * 100,
      );
      const lateSeekMs = Math.max(
        midSeekMs,
        Math.floor((initialReplayState.durationMs * 0.8) / 100) * 100,
      );

      await replayWindow.keyboard.press("Space");
      await waitForReplayState(
        replayWindow,
        {
          isPlaying: false,
          includesText: "ECHO:replay-smoke-check",
        },
      );

      await seekReplay(replayWindow, midSeekMs);
      await expect(replayWindow.getByLabel("Replay scrubber")).toHaveValue(String(midSeekMs));
      const pausedSeekState = await waitForReplayState(
        replayWindow,
        {
          isPlaying: false,
        },
      );
      expect(pausedSeekState?.isPlaying).toBe(false);

      await replayWindow.keyboard.press("Space");
      await waitForReplayState(
        replayWindow,
        {
          isPlaying: true,
        },
      );

      await seekReplay(replayWindow, lateSeekMs);
      await expect(replayWindow.getByLabel("Replay scrubber")).toHaveValue(String(lateSeekMs));
      const playingSeekState = await waitForReplayState(
        replayWindow,
        {
          isPlaying: true,
        },
      );
      expect(playingSeekState?.isPlaying).toBe(true);

      await replayWindow.getByRole("button", { name: "Zoom in" }).click();
      const zoomedState = await waitForReplayState(
        replayWindow,
        {
          zoomPercent: 110,
        },
      );
      expect(zoomedState?.zoomPercent).toBe(110);
    } finally {
      await app.close();
      await rm(userDataDir, { recursive: true, force: true });
      await rm(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });
});
