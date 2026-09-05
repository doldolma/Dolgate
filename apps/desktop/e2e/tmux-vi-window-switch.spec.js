const { test, expect } = require("@playwright/test");
const { spawnSync } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const {
  createFakeAuthSessionJson, drainCleanups, getSessionTerminalState,
  launchDesktop, mkdtemp, os, path, removeFixtureDir, trackCleanup,
  waitForTerminalInputReady, writeDesktopState,
} = require("./helpers");

/**
 * **진짜 vi** 가 있는 tmux 창으로 전환했을 때 화면이 tmux 와 같은가.
 *
 * 합성 전체화면 앱으로는 이 버그를 못 잡는다 — 그런 앱은 WINCH 마다 전체를 다시 그려 잘못된 격자에
 * 그려졌어도 스스로 고친다(htop 이 멀쩡했던 이유). vi 는 스스로 그리지 않아 어긋난 채 남는다.
 *
 * 무엇이 깨졌었나: attach 때 코어가 창 목록을 비활성 창부터 보내면, 렌더러는 **첫** layout 으로 그룹을
 * 만들며 그 창을 활성으로 잡는다. 그 한 프레임 동안 그 창의 pane 들이 xterm 을 만들어 버리는데, 그때 칸
 * 수는 아직 우리 크기를 tmux 에 알리기 전의 세션 생성 크기다. 숨겨진 pane 은 리사이즈되지 않으므로
 * (clientWidth 0 가드) 그 낡은 격자가 굳고, 정착 뒤 떠 온 복원 화면이 거기 그려져 어긋난다.
 * 실측: 전환 전에 이미 `vi xterm 존재=true 격자=100x50` (tmux 는 81x59).
 *
 * 고침은 코어 두 가지다 — (1) 초기 합성에서 **활성 창을 먼저** 내보내 그 찰나를 없애고, (2) 리사이즈가
 * 정착한 뒤 **모든 창**의 레이아웃을 다시 물어 비활성 창의 칸 수가 굳지 않게 한다.
 *
 *   DOLSSH_E2E_USE_PACKAGED_APP=1 DOLGATE_E2E_VM_HOST=… DOLGATE_E2E_VM_PASS=… \
 *     npx playwright test -c playwright.config.ts e2e/tmux-vi-window-switch.spec.js
 * (소스를 고쳤으면 `npm run prepare:ssh-core:dev && npm run ensure:smoke-package` 를 먼저.)
 */
const VM_HOST = process.env.DOLGATE_E2E_VM_HOST;
const VM_USER = process.env.DOLGATE_E2E_VM_USER ?? "ubuntu";
const VM_PASS = process.env.DOLGATE_E2E_VM_PASS;
const SESSION = "e2evi";
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
function setup() {
  vmSsh([
    `tmux kill-session -t ${SESSION} 2>/dev/null`,
    // vi 를 새 버퍼로 열고(파일 안 만듦) insert 모드에서 구분되는 줄을 넣는다.
    `tmux new-session -d -s ${SESSION} -x 200 -y 50 -n vi vi`,
    `sleep 1`,
    `tmux send-keys -t ${SESSION}:0.0 i`,
    `tmux send-keys -t ${SESSION}:0.0 'E2E-VI-AAAA-1' Enter 'E2E-VI-BBBB-2' Enter 'E2E-VI-CCCC-3' Enter 'E2E-VI-DDDD-4'`,
    `tmux split-window -h -t ${SESSION}:0 htop`,
    `tmux new-window -t ${SESSION} -n bash`,
    `tmux send-keys -t ${SESSION}:1 'echo E2E-BASH-MARK' Enter`,
    `tmux select-window -t ${SESSION}:1`,
    `sleep 1`,
    `tmux display -p -t ${SESSION}:0.0 '#{alternate_on} #{pane_width}x#{pane_height}'`,
  ].join("; "));
}

test.describe("vi 창 전환", () => {
  test.afterEach(drainCleanups);
  test("다른 창으로 열렸다가 vi 창으로 전환해도 화면이 tmux 와 같다", async () => {
    test.skip(!VM_HOST || !VM_PASS, "VM env 필요");
    test.setTimeout(180000);
    trackCleanup(() => vmSsh(`tmux kill-session -t ${SESSION} 2>/dev/null; true`));
    setup();

    const userDataDir = await mkdtemp(path.join(os.tmpdir(), "dg-vi-"));
    await writeDesktopState(userDataDir, { hosts: [], knownHosts: [] });
    const app = await launchDesktop({ DOLSSH_USER_DATA_DIR: userDataDir, DOLSSH_E2E_AUTH_SESSION_JSON: createFakeAuthSessionJson(), DOLSSH_E2E_DISABLE_SYNC: "1", DOLSSH_E2E_CAPTURE_TERMINAL: "1" });
    trackCleanup(async ()=>{ await app.close(); await removeFixtureDir(userDataDir); });
    await app.evaluate(({ BrowserWindow })=>{ const w=BrowserWindow.getAllWindows()[0]; w.setSize(1600,1000); w.center(); });
    const page = await app.firstWindow();
    await expect(page.getByRole("button", { name: "New Host" })).toBeVisible({ timeout: 30000 });
    await page.evaluate(async ([d,p])=>{ await window.dolssh.hosts.create(d,{password:p}); },
      [{ kind:"ssh", label:"E2E VM", hostname:VM_HOST, port:22, username:VM_USER, authType:"password", groupName:null, tags:[], terminalThemeId:null }, VM_PASS]);
    await page.reload();
    await expect(page.getByRole("button", { name: "New Host" })).toBeVisible({ timeout: 30000 });
    await page.locator('[data-host-card="true"]').filter({ hasText:"E2E VM" }).first().dblclick();
    const trust = page.getByRole("dialog", { name: "새 호스트 키를 확인해 주세요." });
    await expect(trust).toBeVisible({ timeout: 30000 });
    await trust.getByRole("button", { name: "저장 후 계속" }).click();
    await waitForTerminalInputReady(page, 60000);
    await page.getByRole("button", { name: /세션 패널|Session panel/ }).click();
    await page.getByRole("button", { name: "tmux", exact: true }).click();
    await page.getByRole("button", { name: /e2evi/ }).first().click({ timeout: 30000 });

    const win0 = page.getByRole("tab", { name: /^0:vi/ });
    const win1 = page.getByRole("tab", { name: /^1:bash/ });
    await expect(win1).toHaveAttribute("aria-selected","true",{ timeout:30000 });

    const panes = listPanes();
    const vi = panes.find((p)=>p.win===0 && /vi/.test(p.cmd)) || panes.filter((p)=>p.win===0)[0];
    const htop = panes.filter((p)=>p.win===0).find((p)=>p!==vi);
    console.log("[PANES]", JSON.stringify(panes));

    // 전환 전에는 숨은 창의 pane 이 xterm 을 만들지 않아야 한다 — 만들면 그때의 낡은 칸 수로 굳는다.
    // (단정이 아니라 진단 로그로 남긴다: 숨은 pane 을 올바른 칸 수로 미리 만드는 설계로 바뀌면 이 값은
    //  달라져도 되고, 진짜로 지켜야 하는 것은 아래 "화면이 tmux 와 같다" 이다.)
    {
      const sid = await paneSid(page, vi.num);
      const st = await getSessionTerminalState(page, sid);
      console.log(`[전환전] vi xterm 존재=${st != null} 격자=${st ? `${st.cols}x${st.rows}` : "-"}`);
    }

    const preSwitchWaitMs = Number(process.env.DIAG_PRESWITCH_MS ?? "0");
    if (preSwitchWaitMs > 0) { await page.waitForTimeout(preSwitchWaitMs); }

    // 창 0 으로 전환.
    await win0.click();
    await expect(win0).toHaveAttribute("aria-selected", "true");

    // vi pane 이 tmux 화면으로 **수렴**해야 한다. 전환 직후엔 pane 크기가 한 번 더 정착할 수 있고(세션
    // 패널 등) 그때 vi 가 WINCH 로 다시 그리므로, 양쪽을 반복해 읽어 같아질 때까지 기다린다. 끝내 같지
    // 않으면 그것이 사용자가 보는 깨진 화면이다.
    const sidVi = await paneSid(page, vi.num);
    const deadline = Date.now() + 30000;
    let viRows = [], want = [], size = "", tsize = "";
    for (;;) {
      const st = await getSessionTerminalState(page, sidVi);
      if (st && typeof st.snapshot === "string") {
        size = `${st.cols}x${st.rows}`;
        tsize = vmSsh(`tmux display -p -t ${vi.id} '#{pane_width}x#{pane_height}'`).trim();
        viRows = renderSnapshot(st.snapshot, st.cols, st.rows, "vi");
        want = normalizeRows(vmSsh(`tmux capture-pane -p -t ${vi.id}`).split("\n"));
        const hasMarker = want.some((r) => r.includes("E2E-VI-AAAA-1"));
        if (hasMarker && size === tsize && JSON.stringify(viRows) === JSON.stringify(want)) break;
      }
      if (Date.now() >= deadline) {
        console.log(`[app ${size}]\n` + viRows.map((r) => "  |" + r).join("\n"));
        console.log(`[tmux ${tsize}]\n` + want.map((r) => "  |" + r).join("\n"));
        expect(size, "vi xterm 격자가 tmux pane 과 다르다").toBe(tsize);
        expect(viRows, "전환한 창의 vi 화면이 tmux 와 다르다(깨진 화면)").toEqual(want);
        throw new Error("수렴 실패");
      }
      await page.waitForTimeout(500);
    }

    // htop: 대체화면을 유지하고 격자가 tmux 와 같아야 한다.
    const sidH = await paneSid(page, htop.num);
    const stH = await getSessionTerminalState(page, sidH);
    expect(`${stH.cols}x${stH.rows}`).toBe(vmSsh(`tmux display -p -t ${htop.id} '#{pane_width}x#{pane_height}'`).trim());
    expect(stH.snapshot, "htop 이 대체화면을 잃었다").toContain("[?1049h");
  });
});
