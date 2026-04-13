import {
  getAuthCallbackStateErrorMessage,
  getSyncFailureMessage,
} from "../src/lib/auth-flow";

describe("mobile auth flow helpers", () => {
  test("rejects auth callbacks when the pending state is missing", () => {
    expect(getAuthCallbackStateErrorMessage(null, "state-token")).toContain(
      "로그인 요청을 찾을 수 없습니다",
    );
  });

  test("rejects auth callbacks when the callback state is missing", () => {
    expect(getAuthCallbackStateErrorMessage("expected-state", null)).toContain(
      "누락",
    );
  });

  test("accepts auth callbacks when the state matches exactly", () => {
    expect(
      getAuthCallbackStateErrorMessage("expected-state", "expected-state"),
    ).toBeNull();
  });

  test("formats login sync failures with a distinct prefix", () => {
    expect(
      getSyncFailureMessage(new Error("서버에 연결할 수 없습니다."), "login"),
    ).toContain("로그인은 완료되었지만 동기화에 실패했습니다.");
  });

  test("uses the original sync error message for manual retries", () => {
    expect(
      getSyncFailureMessage(new Error("세션이 만료되었습니다."), "sync"),
    ).toBe("세션이 만료되었습니다.");
  });
});
