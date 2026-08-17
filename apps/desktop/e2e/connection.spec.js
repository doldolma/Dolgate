const { test, expect } = require("@playwright/test");
const {
  createFakeAuthSessionJson,
  createSshHostWithPassword,
  launchDesktop,
  mkdtemp,
  os,
  path,
  rm,
  startFakeSshd,
  waitForCapturedTerminalOutput,
  writeDesktopState,
} = require("./helpers");

/**
 * 연결 화면을 **앱을 띄워** 확인한다.
 *
 * 코어 쪽 시나리오 테스트(services/ssh-core/pkg/runtime)는 이벤트가 올바르게 올라오는지까지만
 * 본다. 그 이벤트를 받아 화면이 무엇을 그리는지는 다른 문제였고, 실기기에서 깨진 것은 대부분
 * 그쪽이었다 — 팝업이 입력창을 덮거나, 남의 탭에 물음이 뜨거나, 아무것도 안 보이거나.
 *
 * 가짜 sshd 를 띄워 그 조건을 만든다(services/ssh-core/internal/sshconn/testfixture).
 */
test.describe("연결 화면", () => {
  const trustCardName = "새 호스트 키를 확인해 주세요.";

  async function boot() {
    const userDataDir = await mkdtemp(
      path.join(os.tmpdir(), "dolssh-connection-"),
    );
    // 호스트는 아래에서 앱의 실제 저장 경로로 만든다 — 비밀번호가 키체인에 들어가야 붙는다.
    await writeDesktopState(userDataDir, { hosts: [], knownHosts: [] });
    const app = await launchDesktop({
      DOLSSH_USER_DATA_DIR: userDataDir,
      DOLSSH_E2E_AUTH_SESSION_JSON: createFakeAuthSessionJson(),
      DOLSSH_E2E_DISABLE_SYNC: "1",
      DOLSSH_E2E_CAPTURE_TERMINAL: "1",
    });
    const page = await app.firstWindow();
    // 부팅이 끝나 호스트 화면이 서야 그 뒤 조작이 먹는다.
    await expect(page.getByRole("button", { name: "New Host" })).toBeVisible({
      timeout: 30_000,
    });
    return {
      page,
      async stop() {
        await app.close();
        await rm(userDataDir, { recursive: true, force: true });
      },
    };
  }

  function hostCard(page, label) {
    return page
      .locator('[data-host-card="true"]')
      .filter({ hasText: label })
      .first();
  }

  /**
   * 처음 보는 호스트는 **그 탭 안에서** 신뢰를 묻고, 수락하면 같은 연결이 이어져야 한다.
   *
   * 다시 연결하지 않는 것이 이 흐름의 요점이다 — 다시 붙으면 OTP 를 한 번 더 물어야 하고, 30초마다
   * 바뀌는 코드로는 통과할 수 없다.
   */
  test("처음 보는 호스트의 키를 탭 안에서 묻고, 수락하면 그대로 붙는다", async () => {
    const sshd = await startFakeSshd({ user: "ubuntu", password: "pw" });
    const booted = await boot();

    try {
      const { page } = booted;
      await createSshHostWithPassword(page, sshd);
      await hostCard(page, "Fake SSHD").dblclick();

      const trustCard = page.getByRole("dialog", { name: trustCardName });
      await expect(trustCard).toBeVisible({ timeout: 30_000 });
      // 지문을 보여 줘야 사용자가 대조할 수 있다.
      await expect(trustCard).toContainText("SHA256:");

      await trustCard.getByRole("button", { name: "저장 후 계속" }).click();

      // 같은 연결이 이어져 셸까지 간다. 가짜 sshd 가 찍는 표식으로 확인한다.
      await waitForCapturedTerminalOutput(page, "READY:FAKE_SSHD", 30_000);
    } finally {
      await booted.stop();
      await sshd.stop();
    }
  });

  /**
   * 탭 두 개가 동시에 물으면 각자 자기 판에서 기다려야 한다.
   *
   * 전역 모달이던 시절에는 보고 있던 탭 위로 남의 물음이 올라왔고, 화면이 그 탭으로 끌려갔다 —
   * 탭이 계속 튕겼다. 지금은 활성 탭의 것 하나만 보이고, 다른 탭의 물음은 그 탭에서 기다린다.
   */
  test("두 탭이 동시에 물어도 화면에는 그 탭의 물음만 뜬다", async () => {
    const first = await startFakeSshd({ user: "ubuntu", password: "pw" });
    const second = await startFakeSshd({ user: "ubuntu", password: "pw" });
    const booted = await boot();

    try {
      const { page } = booted;
      await createSshHostWithPassword(page, first, { label: "Fake A" });
      await createSshHostWithPassword(page, second, { label: "Fake B" });

      await hostCard(page, "Fake A").dblclick();
      const trustCards = page.getByRole("dialog", { name: trustCardName });
      await expect(trustCards).toHaveCount(1, { timeout: 30_000 });

      // 두 번째 호스트도 연결한다. 첫 물음이 덮이거나 사라지면 안 된다.
      //
      // 상단 Home 탭으로 돌아간다 — 신뢰 카드는 그 판 안에 있으므로 목록을 가린다(전역 모달이
      // 아니라는 뜻이기도 하다).
      await page.getByRole("button", { name: "Home" }).click();
      await hostCard(page, "Fake B").dblclick();

      // **하나만** 보인다 — 겹쳐 쌓이지 않는다. 숨은 탭의 물음은 그 판에 남아 있다.
      await expect(trustCards).toHaveCount(1, { timeout: 30_000 });

      // 이 탭의 것을 수락하면 이 탭이 진행한다.
      await trustCards.getByRole("button", { name: "저장 후 계속" }).click();
      await waitForCapturedTerminalOutput(page, "READY:FAKE_SSHD", 30_000);

      // 이 탭에서는 물음이 사라졌고, 앞 탭의 것이 **이어서 뜨지 않는다.**
      //
      // 전역 모달이던 시절에는 하나를 답하면 곧바로 다음 것이 같은 자리에 떴다 — 사용자에게는
      // 팝업이 끝없이 겹쳐 오는 것으로 보였다. 지금은 각자 자기 판에 있으므로 여기서는 0 이다.
      await expect(trustCards).toHaveCount(0);

      // 앞 탭으로 옮기면 답하지 않은 물음이 **그대로** 기다리고 있다. 이것이 "각자 자기 판에서
      // 기다린다" 의 나머지 절반이다 — 지워지지도, 남의 탭으로 옮겨 가지도 않는다.
      await page
        .getByRole("button", { name: "Fake A 세션으로 이동" })
        .click();
      await expect(trustCards).toHaveCount(1, { timeout: 30_000 });
      await expect(trustCards).toContainText(`${first.host}:${first.port}`);
    } finally {
      await booted.stop();
      await first.stop();
      await second.stop();
    }
  });

  /**
   * 점프를 거치는 연결은 **홉이 순서대로** 보여야 한다.
   *
   * 한 줄 문구로는 "연결 중" 밖에 말할 수 없어서, 어디서 막혔는지 사용자가 알 방법이 없었다.
   * 베스천에서 거절된 것과 최종 대상이 안 뜬 것은 해야 할 일이 완전히 다르다.
   *
   * 두 홉 모두 처음 보는 서버라 신뢰를 두 번 묻는다 — 실제로 소켓을 여는 순서대로 온다.
   */
  test("점프를 거치면 홉이 순서대로 보이고 두 홉의 키를 각각 묻는다", async () => {
    const bastion = await startFakeSshd({
      user: "ubuntu",
      password: "pw",
      relay: true,
    });
    const target = await startFakeSshd({ user: "ubuntu", password: "pw" });
    const booted = await boot();

    try {
      const { page } = booted;
      const jump = await createSshHostWithPassword(page, bastion, {
        label: "Bastion",
      });
      expect(jump.id, "점프 호스트 id 를 받아야 체인을 엮을 수 있다").toBeTruthy();
      await createSshHostWithPassword(page, target, {
        label: "Behind Bastion",
        jumpHostIds: [jump.id],
      });

      await hostCard(page, "Behind Bastion").dblclick();

      const trustCard = page.getByRole("dialog", { name: trustCardName });

      // 첫 물음은 **베스천**의 키다 — 소켓을 먼저 여는 홉이 그쪽이다.
      await expect(trustCard).toBeVisible({ timeout: 30_000 });
      await expect(trustCard).toContainText(`${bastion.host}:${bastion.port}`);
      await trustCard.getByRole("button", { name: "저장 후 계속" }).click();

      // 그다음이 최종 대상의 키다. 같은 연결 안에서 이어진다.
      await expect(trustCard).toBeVisible({ timeout: 30_000 });
      await expect(trustCard).toContainText(`${target.host}:${target.port}`);
      await trustCard.getByRole("button", { name: "저장 후 계속" }).click();

      await waitForCapturedTerminalOutput(page, "READY:FAKE_SSHD", 30_000);
    } finally {
      await booted.stop();
      await target.stop();
      await bastion.stop();
    }
  });

  /**
   * OTP 호스트는 **코드만** 물어야 하고, 그 입력창이 무엇에도 덮이지 않아야 한다.
   *
   * 저장된 비밀번호가 있으면 1 라운드는 코어가 자동으로 답한다. 진행 화면이 위에 남아 있으면
   * 사용자가 코드를 넣을 수 없다 — 포워딩에서 실제로 그렇게 막혔다.
   */
  test("OTP 호스트는 코드만 묻고 그 입력창에 바로 타이핑된다", async () => {
    const sshd = await startFakeSshd({
      user: "ubuntu",
      password: "pw",
      otp: "424242",
    });
    const booted = await boot();

    try {
      const { page } = booted;
      await createSshHostWithPassword(page, sshd);
      await hostCard(page, "Fake SSHD").dblclick();

      // 키를 먼저 신뢰한다(신뢰가 인증보다 앞이다).
      const trustCard = page.getByRole("dialog", { name: trustCardName });
      await expect(trustCard).toBeVisible({ timeout: 30_000 });
      await trustCard.getByRole("button", { name: "저장 후 계속" }).click();

      // 인증 코드 칸만 뜬다 — 비밀번호는 저장된 값으로 코어가 답했다.
      const codeField = page.getByLabel("Verification code:");
      await expect(codeField).toBeVisible({ timeout: 30_000 });
      await expect(page.getByLabel("Password:")).toHaveCount(0);

      // 덮인 것이 없다는 뜻으로, 실제로 눌러 타이핑한다.
      await codeField.fill("424242");
      await page.getByRole("button", { name: "응답 보내기" }).click();

      await waitForCapturedTerminalOutput(page, "READY:FAKE_SSHD", 30_000);
    } finally {
      await booted.stop();
      await sshd.stop();
    }
  });
  /**
   * 포워딩도 **무엇을 거쳐 붙는지** 말해야 한다.
   *
   * 예전에는 시작해도 아무 정보가 없었다 — 코어는 홉 진행과 신뢰 질의를 올리는데 화면에 받는
   * 자리가 없어 통째로 버려졌고, 규칙 줄이 `Starting` 에 멈춘 채 이유가 남지 않았다.
   *
   * 진행 팝업 자체는 사람에게 묻는 동안 내려가도록 만들었으므로(입력창을 덮지 않기 위해서다)
   * 여기서는 **그 물음이 뜨고, 답하면 규칙이 실제로 뜬다** 까지를 본다. 팝업 안의 홉 표시는
   * 컴포넌트 테스트가 덮는다(ConnectionProgressModal.test.tsx).
   */
  test("포워딩을 시작하면 경유 호스트의 키를 묻고, 답하면 규칙이 뜬다", async () => {
    const bastion = await startFakeSshd({
      user: "ubuntu",
      password: "pw",
      relay: true,
    });
    const target = await startFakeSshd({ user: "ubuntu", password: "pw" });
    const booted = await boot();

    try {
      const { page } = booted;
      const jump = await createSshHostWithPassword(page, bastion, {
        label: "PF Bastion",
      });
      const host = await createSshHostWithPassword(page, target, {
        label: "PF Target",
        jumpHostIds: [jump.id],
      });

      // 규칙도 앱의 실제 경로로 만든다 — 호스트 id 는 실행 중에 정해진다.
      await page.evaluate(async (hostId) => {
        await window.dolssh.portForwards.create({
          label: "E2E Forward",
          hostId,
          transport: "ssh",
          mode: "local",
          bindAddress: "127.0.0.1",
          // 0 이면 OS 가 빈 포트를 고른다 — 고정 포트는 다른 실행과 부딪친다.
          bindPort: 0,
          targetHost: "127.0.0.1",
          targetPort: 9,
        });
      }, host.id);
      await page.reload();

      await page.getByRole("button", { name: "Port Forwarding" }).click();
      await page
        .getByRole("button", { name: "Start", exact: true })
        .first()
        .click();

      // 포워딩에는 탭이 없으므로 신뢰는 전역 대화상자가 받는다. 경유 호스트의 키가 먼저 온다.
      const trustDialog = page.getByRole("dialog", { name: trustCardName });
      await expect(trustDialog).toBeVisible({ timeout: 30_000 });
      await expect(trustDialog).toContainText(`${bastion.host}:${bastion.port}`);
      await trustDialog.getByRole("button", { name: "저장 후 계속" }).click();

      // 그다음이 최종 대상의 키다.
      await expect(trustDialog).toBeVisible({ timeout: 30_000 });
      await expect(trustDialog).toContainText(`${target.host}:${target.port}`);
      await trustDialog.getByRole("button", { name: "저장 후 계속" }).click();

      // 규칙이 실제로 떴다 — `Starting` 에 멈추지 않는다.
      await expect(page.getByText("Running").first()).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      await booted.stop();
      await target.stop();
      await bastion.stop();
    }
  });
});
