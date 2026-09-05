const { test, expect } = require("@playwright/test");
const { spawnSync } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const {
  createFakeAuthSessionJson,
  drainCleanups,
  getSessionTerminalState,
  launchDesktop,
  mkdtemp,
  os,
  path,
  removeFixtureDir,
  trackCleanup,
  waitForSessionTerminalState,
  waitForTerminalInputReady,
  writeDesktopState,
} = require("./helpers");

/**
 * tmux 창(window)이 둘일 때 **전환한 창의 pane 이 tmux 화면과 같은가** 를 실제 앱으로 확인한다.
 *
 * 코어 쪽 VM 테스트(services/ssh-core/internal/tmuxsession/*_integration_test.go)는 우리가 만든
 * 복원 바이트가 tmux 화면과 같다는 것까지만 본다. 실기기에서 깨진 것은 그 다음이었다 — 처음 보이는
 * 창은 멀쩡한데, 창 바에서 다른 창으로 넘어가면 vi·htop 이 깨졌다. 숨어 있던 창의 pane 은 전환하는
 * 순간에 xterm 이 만들어지고 밀어둔 바이트를 곧바로 받는데, 그 xterm 이 컨테이너 크기로 만들어져
 * tmux 칸 수와 어긋났던 것이다. 그것은 렌더러 문제라 이 층에서만 잡힌다.
 *
 * 실제 tmux 가 있는 VM 이 필요하다(사용자 세션은 건드리지 않고 `e2ewin` 세션만 만들고 지운다):
 *   DOLGATE_E2E_VM_HOST=<host> DOLGATE_E2E_VM_USER=ubuntu DOLGATE_E2E_VM_PASS=<pass> \
 *     DOLSSH_E2E_USE_PACKAGED_APP=1 npx playwright test -c playwright.config.ts e2e/tmux-window-switch.spec.js
 */
const VM_HOST = process.env.DOLGATE_E2E_VM_HOST;
const VM_USER = process.env.DOLGATE_E2E_VM_USER ?? "ubuntu";
const VM_PASS = process.env.DOLGATE_E2E_VM_PASS;
const SESSION = "e2ewin";
// 복원 바이트를 화면으로 바꾸는 하네스 — 코어 VM 테스트와 같은 것을 쓴다(같은 xterm.js).
const RENDER_SCREEN = path.resolve(
  __dirname,
  "../../../services/ssh-core/internal/tmuxsession/testdata/render-screen.cjs",
);

// 원격 출력의 시작 표식. ssh 가 비밀번호 프롬프트 뒤에 남기는 개행과 expect 의 spawn 줄을 이것으로
// 잘라낸다 — 앞쪽 빈 줄을 뭉뚱그려 지우면 capture-pane 의 빈 첫 행까지 사라진다.
const VM_OUTPUT_BEGIN = "__E2E_BEGIN__";

/** VM 에서 명령 하나를 돌리고 stdout 을 돌려준다(비밀번호는 expect 가 넣는다 — sshpass 가 없다). */
function vmSsh(command) {
  const script = [
    "set timeout 60",
    "spawn ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR $env(VM_USER)@$env(VM_HOST) $env(VM_CMD)",
    "expect {",
    '  -re "(?i)password:" { send "$env(VM_PASS)\\r"; exp_continue }',
    "  eof",
    "}",
    "catch wait result",
    "exit [lindex $result 3]",
  ].join("\n");
  const result = spawnSync("expect", ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      VM_HOST,
      VM_USER,
      VM_PASS,
      VM_CMD: `echo ${VM_OUTPUT_BEGIN}; ${command}`,
    },
  });
  if (result.status !== 0) {
    throw new Error(
      `vm ssh failed (${result.status}): ${command}\n${result.stdout}\n${result.stderr}`,
    );
  }
  const output = result.stdout.replace(/\r\n/g, "\n");
  const begin = output.indexOf(`${VM_OUTPUT_BEGIN}\n`);
  if (begin < 0) {
    throw new Error(`vm ssh output has no begin marker: ${command}\n${output}`);
  }
  return output.slice(begin + VM_OUTPUT_BEGIN.length + 1);
}

/** 오른쪽 공백을 지우고 끝의 빈 줄을 버린다 — capture-pane 과 xterm 덤프를 같은 잣대로 놓는다. */
function normalizeRows(rows) {
  const out = rows.map((row) => row.replace(/\s+$/, ""));
  while (out.length > 0 && out[out.length - 1] === "") {
    out.pop();
  }
  return out;
}

/** 렌더러가 publish 한 xterm 직렬화(SerializeAddon)를 같은 크기의 xterm 에 재생해 화면 행으로 만든다. */
function renderSnapshot(snapshot, cols, rows, tag) {
  const file = path.join(
    os.tmpdir(),
    `dolgate-e2e-snapshot-${tag.replace(/[^\w-]/g, "_")}-${process.pid}.bin`,
  );
  writeFileSync(file, snapshot, "utf8");
  const result = spawnSync("node", [RENDER_SCREEN, file, String(cols), String(rows)], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`render-screen failed: ${result.stderr}`);
  }
  return normalizeRows(JSON.parse(result.stdout).rows);
}

/**
 * 결정적인 전체화면 앱(htop·vi 대신). 대체화면으로 들어가 마우스 보고를 켜고 표식을 그린다.
 * 폭을 꽉 채우는 `=` 행이 핵심 — xterm 이 한 칸이라도 좁게 만들어졌으면 그 행이 감기거나 잘린다.
 *
 * **맨 아랫줄(`\033[$rows;1H`)에는 표식을 두지 않는다.** 그 위치는 바이트를 파싱하는 순간의 xterm
 * 높이에 걸린다: attach 직후 tmux 가 pane 을 키우면 원격 앱은 곧바로 새 높이로 다시 그리는데, 그
 * `%output` 이 높이를 알려 주는 `%layout-change` 보다 먼저 도착할 수 있어 `\033[55;1H` 가 아직 50행인
 * xterm 에서 50행으로 잘린다(control mode 자체의 순서 문제라 이 테스트가 볼 것이 아니다). 고정 행
 * (2·4·6·10·12)과 폭 꽉 찬 행만으로 이 테스트가 잡으려는 것 — 잘못된 격자로 만들어 감기고 밀리는 것 —
 * 은 그대로 다 잡힌다.
 * 창 크기가 바뀌면(우리 클라이언트가 붙어 refresh-client 로 크기를 주면) WINCH 로 다시 그린다.
 *
 * VM 에 파일을 쓰지 않는다 — base64 로 실어 stdin 파이프로 bash 에 준다.
 */
const fullScreenApp = [
  "for i in 1 2 3; do echo E2E-NORMAL-$i; done",
  "draw() {",
  "  local cols rows",
  "  cols=$(tput cols); rows=$(tput lines)",
  "  printf '\\033[?1049h\\033[?1000h\\033[?1006h\\033[2J\\033[H'",
  "  printf '\\033[2;3HE2E-ALPHA-ROW2\\033[4;5HE2E-BETA-ROW4\\033[6;1HE2E-GAMMA-ROW6'",
  "  printf '\\033[10;1H'; printf '%*s' \"$cols\" '' | tr ' ' '='",
  "  printf '\\033[12;1HE2E-BELOW-FULL-ROW %sx%s' \"$cols\" \"$rows\"",
  "  printf '\\033[8;11H'",
  "}",
  "trap draw WINCH",
  "draw",
  "while :; do read -t 1 -r _ || true; done",
  "",
].join("\n");

function prepareVmSession() {
  const b64 = Buffer.from(fullScreenApp, "utf8").toString("base64");
  // 창 0: 전체화면 앱 | bash, 창 1: bash. 창 1 을 활성으로 두어 **창 0 이 전환해서 보는 창** 이 된다
  // (사용자가 깨진 것을 본 vi|htop 창이 그 자리다).
  vmSsh(
    [
      `tmux kill-session -t ${SESSION} 2>/dev/null`,
      `tmux new-session -d -s ${SESSION} -x 200 -y 50 -n win0 "echo ${b64} | base64 -d | bash"`,
      `tmux split-window -h -t ${SESSION}:0`,
      `tmux send-keys -t ${SESSION}:0.1 'echo E2E-WIN0-RIGHT-MARK' Enter`,
      `tmux new-window -t ${SESSION} -n win1`,
      `tmux send-keys -t ${SESSION}:1 'echo E2E-WIN1-MARK' Enter`,
      `tmux select-window -t ${SESSION}:1`,
      // 앱이 대체화면에 들어갈 때까지 기다린다.
      `for i in $(seq 1 40); do [ "$(tmux display -p -t ${SESSION}:0.0 '#{alternate_on}')" = 1 ] && break; sleep 0.25; done`,
      `tmux display -p -t ${SESSION}:0.0 '#{alternate_on}'`,
    ].join("; "),
  );
}

/** 세션의 pane 들: { windowIndex, id(%N), num } — 창 안 순서는 tmux 가 주는 순서(왼쪽부터). */
function listVmPanes() {
  return vmSsh(`tmux list-panes -s -t ${SESSION} -F '#{window_index} #{pane_id}'`)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+ %\d+$/.test(line))
    .map((line) => {
      const [windowIndex, id] = line.split(" ");
      return { windowIndex: Number(windowIndex), id, num: id.slice(1) };
    });
}

/** pane(%N) 의 렌더러 세션 id(tmux:<control>:<N>). 바이트를 받은 pane 만 나타난다. */
async function paneSessionId(page, pane) {
  const handle = await page.waitForFunction(
    (suffix) => {
      const e2e = window.__dolsshE2E;
      if (!e2e || typeof e2e.getTerminalOutputs !== "function") {
        return null;
      }
      const keys = Object.keys(e2e.getTerminalOutputs());
      return keys.find((key) => key.startsWith("tmux:") && key.endsWith(`:${suffix}`)) ?? null;
    },
    pane.num,
    { timeout: 30_000 },
  );
  const sessionId = await handle.jsonValue();
  await handle.dispose();
  return sessionId;
}

/**
 * pane 의 xterm 이 tmux 가 들고 있는 그 pane 화면으로 **수렴하는가.**
 *
 * 왜 한 방 대조가 아니라 수렴인가. 우리가 refresh-client 로 크기를 주면 원격 앱(bash 는 프롬프트,
 * 전체화면 앱은 trap 재그리기)이 SIGWINCH 로 화면을 다시 그린다. 그 재그리기가 앱 스냅샷과
 * capture-pane 사이에 끼면 한 줄 어긋난다 — 화면이 깨진 게 아니라 양쪽이 서로 다른 순간을 본 것이다.
 * 그래서 양쪽을 **같은 순간에 가깝게** 반복해 읽어 같아질 때까지 기다린다. 끝내 같아지지 않으면
 * 그때는 진짜로 앱이 tmux 와 다른 화면을 그리는 것이다(=버그).
 *
 * 앱 화면은 렌더러가 publish 한 xterm 직렬화를 같은 크기 xterm 에 재생해서 얻는다(사용자가 실제로
 * 보는 것). tmux 화면은 capture-pane 이다. 둘 다 뷰포트라 같은 잣대다.
 */
async function expectPaneConvergesToTmux(page, pane, marker, tag, { timeout = 30_000 } = {}) {
  const sessionId = await paneSessionId(page, pane);
  const deadline = Date.now() + timeout;
  let lastRendered = [];
  let lastExpected = [];
  let lastState = null;
  // 먼저 표식이 원격에 실제로 있는지 확인한다 — capture-pane 이 빈 화면이면 "둘 다 비어서 일치" 로
  // 통과하는 것을 막는다.
  for (;;) {
    const state = await getSessionTerminalState(page, sessionId);
    if (state && typeof state.snapshot === "string") {
      lastState = state;
      lastRendered = renderSnapshot(state.snapshot, state.cols, state.rows, tag);
      lastExpected = normalizeRows(vmSsh(`tmux capture-pane -p -t ${pane.id}`).split("\n"));
      const markerOnScreen = lastExpected.some((row) => row.includes(marker));
      if (markerOnScreen && arraysEqual(lastRendered, lastExpected)) {
        return state;
      }
    }
    if (Date.now() >= deadline) {
      console.log(`[DIAG ${tag}] ${sessionId}`);
      console.log("  app 격자:", lastState ? `${lastState.cols}x${lastState.rows}` : "(상태없음)");
      console.log("  app 화면:\n" + lastRendered.map((r) => "    |" + r).join("\n"));
      console.log("  tmux 화면:\n" + lastExpected.map((r) => "    |" + r).join("\n"));
      expect(lastRendered, `${tag}: 앱 화면이 tmux 로 수렴하지 않음`).toEqual(lastExpected);
      throw new Error(`${tag}: 수렴 실패`);
    }
    await page.waitForTimeout(500);
  }
}

function arraysEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((value, index) => value === b[index]);
}

/**
 * 라이브 bash 셸 pane 은 **화면 바이트 정확 대조를 하지 않는다.** 복원 자체는 정확하다(코어 VM 테스트
 * TestVMReattachDoesNotReinstallShellIntegration·RestoresSplitPanes 가 셸 화면 전 행 일치를 증명한다).
 * 다만 복원 뒤 우리가 refresh-client 로 크기를 주면 bash 가 SIGWINCH 로 프롬프트를 다시 그리는데,
 * capture-pane 은 스크롤백이 없고 라이브 xterm 은 있어 스크롤 위치가 한 줄 어긋난다 — 내용은 다 있고
 * 크기도 맞는데 앵커만 다르다. 이 흔들림은 화면 깨짐이 아니므로, 셸에서는 **정말 중요한 것**만 본다:
 *   (1) xterm 격자가 tmux pane 크기와 같은가 — 창 전환에서 깨졌던 바로 그 부분(잘못된 크기로 만들면
 *       내용이 감기고 안 돌아온다). 이게 이 테스트가 셸에 대해 유일하게 새로 증명하는 것이다.
 *   (2) 표식이 실제로 전달됐는가(raw 스트림) — pane 이 내용을 받았다.
 *   (3) 렌더된 화면에 셸 통합 주입 흔적이 없는가 — 재attach 가 셸에 타이핑하지 않았다.
 * 전체화면(vi·htop)은 trap 재그리기가 결정적이라 위 expectPaneConvergesToTmux 로 정확 대조한다.
 */
async function expectShellPaneRestored(page, pane, marker, tag) {
  const sessionId = await paneSessionId(page, pane);
  // (2) 표식이 raw 스트림에 온다(스크롤백으로 밀려도 raw 로그엔 남으므로 뷰포트보다 안정적).
  await page.waitForFunction(
    (input) => (window.__dolsshE2E.getTerminalOutputs()[input.sid] ?? "").includes(input.marker),
    { sid: sessionId, marker },
    { timeout: 30_000 },
  );
  // 전환 직후 크기 보고가 정착하도록 잠깐 둔다.
  await page.waitForTimeout(800);
  const state = await getSessionTerminalState(page, sessionId);
  expect(state, `${tag}: 상태 없음`).not.toBeNull();

  // (1) 격자 == tmux pane 크기.
  const [width, height] = vmSsh(`tmux display -p -t ${pane.id} '#{pane_width} #{pane_height}'`)
    .trim()
    .split(" ")
    .map(Number);
  expect({ cols: state.cols, rows: state.rows }, `${tag}: xterm 격자가 tmux pane 과 다름`).toEqual({
    cols: width,
    rows: height,
  });

  // (3) 렌더된 화면에 주입 흔적 없음.
  const rendered = renderSnapshot(state.snapshot, state.cols, state.rows, tag).join("\n");
  for (const trace of ["eval ", "show-buffer", "delete-buffer", "dolgate-init", "load-buffer"]) {
    expect(rendered, `${tag}: 셸에 주입 흔적(${trace})`).not.toContain(trace);
  }
  return state;
}

test.describe("tmux 창 전환", () => {
  test.afterEach(drainCleanups);

  test("두 창을 오가도 전환한 창의 pane 화면이 tmux 와 같다", async () => {
    test.skip(!VM_HOST || !VM_PASS, "DOLGATE_E2E_VM_HOST / DOLGATE_E2E_VM_PASS 가 필요하다");
    test.setTimeout(240_000);

    // VM 세션은 맨 마지막에 지운다(앱이 먼저 떨어져야 한다 — 정리는 역순).
    trackCleanup(() => {
      vmSsh(`tmux kill-session -t ${SESSION} 2>/dev/null; true`);
    });
    prepareVmSession();

    const userDataDir = await mkdtemp(path.join(os.tmpdir(), "dolgate-tmux-2win-"));
    await writeDesktopState(userDataDir, { hosts: [], knownHosts: [] });
    const app = await launchDesktop({
      DOLSSH_USER_DATA_DIR: userDataDir,
      DOLSSH_E2E_AUTH_SESSION_JSON: createFakeAuthSessionJson(),
      DOLSSH_E2E_DISABLE_SYNC: "1",
      DOLSSH_E2E_CAPTURE_TERMINAL: "1",
    });
    trackCleanup(async () => {
      await app.close();
      await removeFixtureDir(userDataDir);
    });
    // 분할된 두 pane 이 둘 다 넉넉히 넓도록 창을 키운다.
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setSize(1600, 1000);
      win.center();
    });

    const page = await app.firstWindow();
    await expect(page.getByRole("button", { name: "New Host" })).toBeVisible({
      timeout: 30_000,
    });

    // 호스트는 앱의 저장 경로로 만든다 — 비밀번호가 키체인에 들어가야 붙는다.
    const hostDraft = {
      kind: "ssh",
      label: "E2E VM",
      hostname: VM_HOST,
      port: 22,
      username: VM_USER,
      authType: "password",
      groupName: null,
      tags: [],
      terminalThemeId: null,
    };
    await page.evaluate(
      async ([draft, password]) => {
        await window.dolssh.hosts.create(draft, { password });
      },
      [hostDraft, VM_PASS],
    );
    await page.reload();
    await expect(page.getByRole("button", { name: "New Host" })).toBeVisible({
      timeout: 30_000,
    });

    await page
      .locator('[data-host-card="true"]')
      .filter({ hasText: "E2E VM" })
      .first()
      .dblclick();
    const trustCard = page.getByRole("dialog", { name: "새 호스트 키를 확인해 주세요." });
    await expect(trustCard).toBeVisible({ timeout: 30_000 });
    await trustCard.getByRole("button", { name: "저장 후 계속" }).click();
    await waitForTerminalInputReady(page, 60_000);

    // 세션 패널 → tmux 섹션 → e2ewin 세션으로 붙는다(control mode). 패널은 마지막에 보던 섹션으로
    // 열리므로 tmux 섹션 버튼을 따로 누른다(푸터의 "tmux 세션 관리" 와는 다른 버튼이다).
    await page.getByRole("button", { name: /세션 패널|Session panel/ }).click();
    await page.getByRole("button", { name: "tmux", exact: true }).click();
    await page.getByRole("button", { name: /e2ewin/ }).first().click({ timeout: 30_000 });

    const win0Tab = page.getByRole("tab", { name: /^0:win0/ });
    const win1Tab = page.getByRole("tab", { name: /^1:win1/ });
    await expect(win1Tab).toBeVisible({ timeout: 30_000 });
    await expect(win1Tab).toHaveAttribute("aria-selected", "true");

    const panes = listVmPanes();
    const win0Full = panes.find((pane) => pane.windowIndex === 0);
    const win0Shell = panes.filter((pane) => pane.windowIndex === 0)[1];
    const win1Shell = panes.find((pane) => pane.windowIndex === 1);
    expect(win0Full && win0Shell && win1Shell, `pane 목록: ${JSON.stringify(panes)}`).toBeTruthy();

    // 처음 보이는 창(1) — 원래 멀쩡하던 쪽.
    await expectShellPaneRestored(page, win1Shell, "E2E-WIN1-MARK", "첫 표시 창1");

    // 전환한 창(0) — 숨어 있다가 이제 xterm 이 만들어지는 pane 들. 전체화면 앱 + 셸.
    await win0Tab.click();
    await expect(win0Tab).toHaveAttribute("aria-selected", "true");
    const full = await expectPaneConvergesToTmux(page, win0Full, "E2E-BELOW-FULL-ROW", "전환 창0 전체화면");
    // 대체화면(전체화면 앱)이어야 한다 — 주 화면으로 떨어졌으면 복원이 화면 종류를 잃은 것.
    expect(full.snapshot).toContain("[?1049h");
    await expectShellPaneRestored(page, win0Shell, "E2E-WIN0-RIGHT-MARK", "전환 창0 셸");

    // 되돌아가고, 다시 온다 — 오갈수록 깨지던 경우.
    await win1Tab.click();
    await expect(win1Tab).toHaveAttribute("aria-selected", "true");
    await expectShellPaneRestored(page, win1Shell, "E2E-WIN1-MARK", "복귀 창1");

    await win0Tab.click();
    await expect(win0Tab).toHaveAttribute("aria-selected", "true");
    await expectPaneConvergesToTmux(page, win0Full, "E2E-BELOW-FULL-ROW", "재전환 창0 전체화면");
    await expectShellPaneRestored(page, win0Shell, "E2E-WIN0-RIGHT-MARK", "재전환 창0 셸");
  });
});
