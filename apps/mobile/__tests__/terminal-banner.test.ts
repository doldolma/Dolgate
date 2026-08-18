import { appendSessionBanner } from "../src/lib/terminal-banner";

const BANNER = "# Tailscale SSH requires an additional check.\nvisit https://example";
const BLOCK = "# Tailscale SSH requires an additional check.\r\nvisit https://example\r\n";

describe("서버 배너를 세션 스냅샷에 합치기", () => {
  it("빈 스냅샷에는 배너만 남는다", () => {
    expect(appendSessionBanner(undefined, BANNER)).toBe(BLOCK);
    expect(appendSessionBanner("", BANNER)).toBe(BLOCK);
  });

  it("줄바꿈을 CRLF 로 맞춘다", () => {
    // xterm 은 \n 만으로 열을 되돌리지 않아 줄이 계단처럼 밀린다.
    const merged = appendSessionBanner("", "one\ntwo");
    expect(merged).toBe("one\r\ntwo\r\n");
    expect(merged).not.toMatch(/[^\r]\n/);
  });

  it("이미 있던 출력 뒤에 붙는다", () => {
    expect(appendSessionBanner("prior output\r\n", BANNER)).toBe(
      `prior output\r\n${BLOCK}`,
    );
  });

  it("같은 배너를 두 번 쌓지 않는다", () => {
    // 서버가 배너를 다시 보내거나 이벤트가 중복 전달돼도 화면이 겹치면 안 된다.
    const once = appendSessionBanner("", BANNER);
    expect(once).toBe(BLOCK);
    expect(appendSessionBanner(once ?? "", BANNER)).toBeNull();
  });

  it("이미 CRLF 인 배너도 그대로 한 번만", () => {
    const crlf = "line a\r\nline b";
    const once = appendSessionBanner("", crlf);
    expect(once).toBe("line a\r\nline b\r\n");
    expect(appendSessionBanner(once ?? "", crlf)).toBeNull();
  });

  it("배너가 없으면 아무것도 하지 않는다", () => {
    for (const banner of ["", "   ", "\n\n"]) {
      expect(appendSessionBanner("prior", banner)).toBeNull();
    }
  });
});
