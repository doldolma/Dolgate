import { describe, expect, it } from "vitest";
import { HostGoneError } from "./host-gone-error";

// 메인에서 던진 오류는 IPC 를 건너며 `Error invoking remote method '…': <문자열로 바꾼 오류>` 로 화면에 간다. 화면은 그 앞과
// 'Error: '만 벗긴다(`normalizeRemoteInvokeErrorMessage`) — 이름을 바꿨을 때는 'HostGoneError: ' 가 까닭 앞에 남았다.
describe("HostGoneError", () => {
  it("crosses IPC as a plain error, so the screen shows only the reason", () => {
    const error = new HostGoneError("팀에서 빠져 이 연결을 닫았습니다.");

    expect(String(error)).toBe("Error: 팀에서 빠져 이 연결을 닫았습니다.");
    expect(error).toBeInstanceOf(HostGoneError);
    expect(error).toBeInstanceOf(Error);
  });
});
