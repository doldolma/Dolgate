import { getServerUrlIssue } from "@dolssh/shared-core";

import { getServerUrlValidationMessage } from "../src/i18n/shared-messages";

// shared-core 는 코드만 돌려준다(UI 언어를 결정하지 않는다) — 문구는 앱이 만든다.
describe("mobile settings validation", () => {
  test("accepts origin-only server urls", () => {
    expect(getServerUrlIssue("https://ssh.doldolma.com")).toBeNull();
    expect(getServerUrlValidationMessage("https://ssh.doldolma.com")).toBeNull();
  });

  test("rejects server urls with paths", () => {
    expect(getServerUrlIssue("https://ssh.doldolma.com/login")).toBe("has-path");
  });

  test("maps the code to this app's message", () => {
    expect(
      getServerUrlValidationMessage("https://ssh.doldolma.com/login"),
    ).toContain("경로");
  });
});
