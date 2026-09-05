const { test, expect } = require("@playwright/test");
const { spawnSync } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const {
  createFakeAuthSessionJson, drainCleanups, getSessionTerminalState,
  launchDesktop, mkdtemp, os, path, removeFixtureDir, trackCleanup,
  waitForTerminalInputReady, writeDesktopState,
} = require("./helpers");

/**
 * pane 을 리사이즈했을 때 앱 화면이 tmux 와 같은가 — 특히 **넓힐 때**.
 *
 * 무엇이 깨졌었나: 원격 출력(%output)은 xterm 에 즉시 쓰이는데 격자 변경만 리사이즈 스케줄러(rAF 두 번
 * + 드래그 중이면 100ms 정착)를 거쳤다. pane 을 넓히면 새 폭으로 그려진 재그리기가 아직 좁은 격자에서
 * **감기며 행이 늘어나 화면이 위로 밀리고**, 뒤늦게 격자를 넓혀도 감긴 줄은 돌아오지 않는다(vi 는 스스로
 * 다시 그리지 않는다). 줄일 때는 감김이 없어 무사해서 "특정 크기에서만" 깨지는 것처럼 보였다.
 * 실측: 44→52 로 넓히면 +50ms 에 tmux 는 52, xterm 은 아직 44 였고 첫 줄이 스크롤로 사라졌다.
 *
 * 그래서 **줄였다 늘렸다를 섞어** 돌리고, 매 폭마다 앱 화면과 capture-pane 을 글자 단위로 대조한다.
 * 늘리는 구간이 없으면 이 버그는 잡히지 않는다.
 *
 *   DOLSSH_E2E_USE_PACKAGED_APP=1 DOLGATE_E2E_VM_HOST=… DOLGATE_E2E_VM_PASS=… \
 *     npx playwright test -c playwright.config.ts e2e/tmux-pane-resize.spec.js
 */
const VM_HOST = process.env.DOLGATE_E2E_VM_HOST;
const VM_USER = process.env.DOLGATE_E2E_VM_USER ?? "ubuntu";
const VM_PASS = process.env.DOLGATE_E2E_VM_PASS;
const SESSION = "e2erz";
const RENDER_SCREEN = path.resolve(__dirname, "../../../services/ssh-core/internal/tmuxsession/testdata/render-screen.cjs");
const BEGIN = "__E2E_BEGIN__";

function vmSsh(command) {
  const script = [
    "set timeout 60",
    "spawn ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR $env(VM_USER)@$env(VM_HOST) $env(VM_CMD)",
    "expect {", '  -re "(?i)password:" { send "$env(VM_PASS)\\r"; exp_continue }', "  eof", "}",
    "catch wait result", "exit [lindex $result 3]",
  ].join("\n");
  const r = spawnSync("expect", ["-c", script], { encoding: "utf8", env: { ...process.env, VM_HOST, VM_USER, VM_PASS, VM_CMD: `echo ${BEGIN}; ${command}` } });
  if (r.status !== 0) throw new Error(`vm ssh failed(${r.status}): ${command}\n${r.stdout}\n${r.stderr}`);
  const out = r.stdout.replace(/\r\n/g, "\n");
  const b = out.indexOf(`${BEGIN}\n`);
  if (b < 0) throw new Error(`no begin marker: ${command}\n${out}`);
  return out.slice(b + BEGIN.length + 1);
}
function normalizeRows(rows) { const o = rows.map((r) => r.replace(/\s+$/, "")); while (o.length && o[o.length-1]==="") o.pop(); return o; }
function renderSnapshot(snapshot, cols, rows, tag) {
  const f = path.join(os.tmpdir(), `dg-vi-${tag}-${process.pid}.bin`); writeFileSync(f, snapshot, "utf8");
  const r = spawnSync("node", [RENDER_SCREEN, f, String(cols), String(rows)], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`render failed: ${r.stderr}`);
  return normalizeRows(JSON.parse(r.stdout).rows);
}
function listPanes() {
  return vmSsh(`tmux list-panes -s -t ${SESSION} -F '#{window_index} #{pane_id} #{pane_current_command}'`)
    .split("\n").map((l)=>l.trim()).filter((l)=>/^\d+ %\d+/.test(l))
    .map((l)=>{ const [wi,id,...cmd]=l.split(" "); return { win:Number(wi), id, num:id.slice(1), cmd:cmd.join(" ") }; });
}
async function paneSid(page, num) {
  const h = await page.waitForFunction((n)=>{ const e=window.__dolsshE2E; if(!e)return null;
    return Object.keys(e.getTerminalOutputs()).find((k)=>k.startsWith("tmux:")&&k.endsWith(`:${n}`))??null; }, num, { timeout: 30000 });
  const s = await h.jsonValue(); await h.dispose(); return s;
}

// 진짜 vi 를 insert 모드로 띄우고, htop 과 좌우 분할. 창 1(bash)을 활성으로 두어 "다른 창으로 열림".

// vi 하나 + htop 좌우 분할, 창 하나(활성). 사용자가 분할선을 끄는 상황과 같은 downstream 경로다
// (tmux 가 pane 을 리사이즈 → vi WINCH 재그리기 %output + %layout-change → 렌더러).
function setup() {
  vmSsh([
    `tmux kill-session -t ${SESSION} 2>/dev/null`,
    `tmux new-session -d -s ${SESSION} -x 200 -y 50 -n vi vi`,
    `sleep 1`,
    `tmux send-keys -t ${SESSION}:0.0 i`,
    `tmux send-keys -t ${SESSION}:0.0 'E2E-VI-AAAA-1' Enter 'E2E-VI-BBBB-2' Enter 'E2E-VI-CCCC-3' Enter 'E2E-VI-DDDD-4'`,
    `tmux split-window -h -t ${SESSION}:0 htop`,
    `sleep 1`,
  ].join("; "));
}

test.describe("pane 리사이즈", () => {
  test.afterEach(drainCleanups);
  test("줄였다 늘렸다 해도 vi 화면이 tmux 와 같다", async () => {
    test.skip(!VM_HOST || !VM_PASS, "VM env 필요");
    test.setTimeout(300000);
    trackCleanup(() => vmSsh(`tmux kill-session -t ${SESSION} 2>/dev/null; true`));
    setup();

    const userDataDir = await mkdtemp(path.join(os.tmpdir(), "dg-rz-"));
    await writeDesktopState(userDataDir, { hosts: [], knownHosts: [] });
    const app = await launchDesktop({ DOLSSH_USER_DATA_DIR: userDataDir, DOLSSH_E2E_AUTH_SESSION_JSON: createFakeAuthSessionJson(), DOLSSH_E2E_DISABLE_SYNC: "1", DOLSSH_E2E_CAPTURE_TERMINAL: "1" });
    trackCleanup(async () => { await app.close(); await removeFixtureDir(userDataDir); });
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1600, 1000); w.center(); });
    const page = await app.firstWindow();
    await expect(page.getByRole("button", { name: "New Host" })).toBeVisible({ timeout: 30000 });
    await page.evaluate(async ([d, p]) => { await window.dolssh.hosts.create(d, { password: p }); },
      [{ kind: "ssh", label: "E2E VM", hostname: VM_HOST, port: 22, username: VM_USER, authType: "password", groupName: null, tags: [], terminalThemeId: null }, VM_PASS]);
    await page.reload();
    await expect(page.getByRole("button", { name: "New Host" })).toBeVisible({ timeout: 30000 });
    await page.locator('[data-host-card="true"]').filter({ hasText: "E2E VM" }).first().dblclick();
    const trust = page.getByRole("dialog", { name: "새 호스트 키를 확인해 주세요." });
    await expect(trust).toBeVisible({ timeout: 30000 });
    await trust.getByRole("button", { name: "저장 후 계속" }).click();
    await waitForTerminalInputReady(page, 60000);
    await page.getByRole("button", { name: /세션 패널|Session panel/ }).click();
    await page.getByRole("button", { name: "tmux", exact: true }).click();
    await page.getByRole("button", { name: /e2erz/ }).first().click({ timeout: 30000 });
    await page.waitForTimeout(4000); // attach + 복원 + 레이아웃 정착

    const panes = listPanes();
    const vi = panes.find((p) => /vi/.test(p.cmd)) || panes[0];
    const sid = await paneSid(page, vi.num);
    const tmuxSize = () => vmSsh(`tmux display -p -t ${vi.id} '#{pane_width}x#{pane_height}'`).trim();
    const appState = async () => await getSessionTerminalState(page, sid);

    async function compare(label) {
      const st = await appState();
      const t = tmuxSize();
      const a = st ? `${st.cols}x${st.rows}` : "-";
      const appRows = st ? renderSnapshot(st.snapshot, st.cols, st.rows, "rz") : [];
      const want = normalizeRows(vmSsh(`tmux capture-pane -p -t ${vi.id}`).split("\n"));
      const same = JSON.stringify(appRows) === JSON.stringify(want);
      console.log(`[${label}] app=${a} tmux=${t} 크기일치=${a === t} 내용일치=${same}`);
      return { same, a, t, appRows, want };
    }

    const base = await compare("기준선");
    expect(base.same, "기준선부터 어긋나 있다").toBe(true);

    // 여러 폭으로 리사이즈. 각 폭마다 (1) 리사이즈 직후 50ms (2) 정착 후 1200ms 를 본다.
    let broken = 0;
    for (const w of [70, 60, 50, 44, 52, 62, 72, 82, 92, 60, 90]) { // 줄였다 늘렸다 섞는다
      vmSsh(`tmux resize-pane -t ${vi.id} -x ${w}`);
      await page.waitForTimeout(50);
      const early = await appState();
      const earlySize = early ? `${early.cols}x${early.rows}` : "-";
      const earlyTmux = tmuxSize();
      console.log(`  -x ${w} → [+50ms] app=${earlySize} tmux=${earlyTmux}`);
      expect(earlySize, `pane 을 ${w} 로 바꾼 직후에도 격자가 따라오지 않으면, 그 사이 도착한 재그리기가 옛 격자에서 감긴다`).toBe(earlyTmux);
      await page.waitForTimeout(1200);
      const r = await compare(`  -x ${w} [정착]`);
      if (!r.same) {
        broken += 1;
        if (broken <= 2) {
          console.log(`    [app ${r.a}]\n` + r.appRows.map((x) => "      |" + x).join("\n"));
          console.log(`    [tmux ${r.t}]\n` + r.want.map((x) => "      |" + x).join("\n"));
        }
      }
    }
    console.log(`[요약] 불일치 폭 ${broken}개`);
    expect(broken, "리사이즈 뒤 vi 화면이 tmux 와 다르다(감긴 줄로 화면이 밀렸다)").toBe(0);
  });
});
