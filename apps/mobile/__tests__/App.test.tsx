import { getServerUrlValidationMessage } from "@dolssh/shared-core";

describe("mobile settings validation", () => {
  test("accepts origin-only server urls", () => {
    expect(getServerUrlValidationMessage("https://ssh.doldolma.com")).toBeNull();
  });

  test("rejects server urls with paths", () => {
    expect(
      getServerUrlValidationMessage("https://ssh.doldolma.com/login"),
    ).toContain("경로");
  });
});
