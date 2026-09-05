const { test, expect } = require("@playwright/test");
const {
  buildAwsFixture,
  createFakeAuthSessionJson,
  getCapturedSessionId,
  drainCleanups,
  launchDesktop,
  mkdtemp,
  os,
  trackCleanup,
  path,
  removeFixtureDir,
  waitForFakeAwsSessionReady,
  waitForSessionTerminalState,
  writeDesktopState,
} = require("./helpers");

async function waitForTerminalResize(page, sessionId, previousState, expectedText) {
  const handle = await page.waitForFunction(
    (input) => {
      const e2e = window.__dolsshE2E;
      if (!e2e || typeof e2e.getSessionTerminalState !== "function") {
        return null;
      }

      const state = e2e.getSessionTerminalState(input.sessionId);
      if (!state || typeof state.snapshot !== "string") {
        return null;
      }
      if (!state.snapshot.includes(input.expectedText)) {
        return null;
      }
      if (state.cols === input.previousCols && state.rows === input.previousRows) {
        return null;
      }
      return state;
    },
    {
      sessionId,
      previousCols: previousState.cols,
      previousRows: previousState.rows,
      expectedText,
    },
    { timeout: 15_000 },
  );
  const state = await handle.jsonValue();
  await handle.dispose();
  return state;
}

test.describe("desktop TUI regression", () => {
  // 정리는 훅에서 한다 — 본문 finally 에서 하면 정리 실패가 테스트 결과를 덮는다(helpers 참고).
  test.afterEach(drainCleanups);

  test("renders deterministic fake top and fake vi flows inside the live terminal", async () => {
    const userDataDir = await mkdtemp(
      path.join(os.tmpdir(), "dolssh-smoke-tui-"),
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
    // 여기서 등록해 두면 아래에서 무엇이 실패해도 앱과 데이터 디렉터리가 남지 않는다.
    trackCleanup(async () => {
      await app.close();
      await removeFixtureDir(userDataDir);
    });

    const page = await app.firstWindow();
    const awsCard = page
      .locator('[data-host-card="true"]')
      .filter({ hasText: "Smoke AWS" })
      .first();

    await expect(awsCard).toBeVisible();
    await awsCard.dblclick();
    await waitForFakeAwsSessionReady(page);

    const sessionId = await getCapturedSessionId(page);
    await waitForSessionTerminalState(page, sessionId, {
      includesText: "PROMPT> ready",
      hasOutput: true,
    });

    const terminalCanvas = page.locator('[data-terminal-canvas="true"]');
    await terminalCanvas.click();

    await page.keyboard.type("__START_FAKE_TOP__");
    await page.keyboard.press("Enter");
    // 프레임이 **끝까지** 왔는지는 마지막 줄(푸터)로 판단한다. 첫 줄(헤더)로 기다리면 프레임이
    // 도착하기 시작한 순간에 풀려, 아직 오지 않은 꼬리를 단정하게 된다.
    const topState = await waitForSessionTerminalState(page, sessionId, {
      includesText: "Press q to quit fake top",
      hasOutput: true,
    });
    expect(topState.snapshot).toContain("top - fake session");
    expect(topState.snapshot).toContain("Press q to quit fake top");

    await app.evaluate(({ BrowserWindow }) => {
      const [window] = BrowserWindow.getAllWindows();
      window?.setSize(1500, 980);
    });
    await page.waitForFunction(() => window.innerWidth >= 1200, {
      timeout: 15_000,
    });
    const resizedTopState = await waitForTerminalResize(
      page,
      sessionId,
      topState,
      "Press q to quit fake top",
    );
    expect(
      resizedTopState.cols !== topState.cols ||
        resizedTopState.rows !== topState.rows,
    ).toBe(true);
    expect(resizedTopState.snapshot).toContain("Press q to quit fake top");

    await terminalCanvas.click();
    await page.keyboard.type("q");
    await page.keyboard.press("Enter");
    const shellAfterTop = await waitForSessionTerminalState(page, sessionId, {
      includesText: "PROMPT> ready",
      hasOutput: true,
    });
    expect(shellAfterTop.snapshot).toContain("PROMPT> ready");

    await terminalCanvas.click();
    await page.keyboard.type("__START_FAKE_VI__");
    await page.keyboard.press("Enter");
    const viState = await waitForSessionTerminalState(page, sessionId, {
      includesText: "\"fake.txt\"",
      hasOutput: true,
    });
    expect(viState.snapshot).toContain("NORMAL  fake.txt");

    await app.evaluate(({ BrowserWindow }) => {
      const [window] = BrowserWindow.getAllWindows();
      window?.setSize(1180, 760);
    });
    await page.waitForFunction(() => window.innerWidth <= 1180, {
      timeout: 15_000,
    });
    const resizedViState = await waitForTerminalResize(
      page,
      sessionId,
      viState,
      "\"fake.txt\"",
    );
    expect(
      resizedViState.cols !== viState.cols ||
        resizedViState.rows !== viState.rows,
    ).toBe(true);
    expect(resizedViState.snapshot).toContain("NORMAL  fake.txt");

    await terminalCanvas.click();
    await page.keyboard.type(":q");
    await page.keyboard.press("Enter");
    const shellAfterVi = await waitForSessionTerminalState(page, sessionId, {
      includesText: "PROMPT> ready",
      hasOutput: true,
    });
    expect(shellAfterVi.snapshot).toContain("PROMPT> ready");
  });
});
