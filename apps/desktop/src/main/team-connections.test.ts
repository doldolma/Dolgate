import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/dolgate-test-user-data", isPackaged: false },
}));

import { closeTeamConnections, type HostConnectionCloser } from "./team-connections";

const storage = {
  getTeamState: (teamId: string) =>
    teamId === "team-1" ? ({ info: { name: "Acme Infra" } } as never) : null,
};

function closer(count: number) {
  const calls: Array<{ hostIds: string[]; notice: string }> = [];
  const value: HostConnectionCloser = {
    close: (hostIds, notice) => {
      calls.push({ hostIds: [...hostIds], notice });
      return count;
    },
  };
  return { value, calls };
}

describe("closeTeamConnections", () => {
  it("asks every closer to close the team's hosts and leaves one warning line", () => {
    const core = closer(2);
    const rdp = closer(1);
    const appendLog = vi.fn();

    const closed = closeTeamConnections("team-1", new Set(["h1", "h2"]), [core.value, rdp.value], appendLog, storage);

    expect(closed).toBe(3);
    expect(core.calls).toEqual([{ hostIds: ["h1", "h2"], notice: "팀에서 빠져 이 연결을 닫았습니다." }]);
    expect(rdp.calls).toEqual(core.calls);
    expect(appendLog).toHaveBeenCalledTimes(1);
    expect(appendLog.mock.calls[0][0]).toMatchObject({
      message: "Acme Infra 팀에서 빠져 그 팀 호스트의 연결 3개를 닫았습니다.",
      messageKey: "teams.connectionsClosed.log",
    });
    expect(appendLog.mock.calls[0][1]).toEqual({ closed: 3 });
  });

  it("does nothing for a team without hosts, and logs nothing when nothing was open", () => {
    const core = closer(0);
    const appendLog = vi.fn();

    expect(closeTeamConnections("team-1", new Set(), [core.value], appendLog, storage)).toBe(0);
    expect(core.calls).toEqual([]);

    expect(closeTeamConnections("team-1", new Set(["h1"]), [core.value], appendLog, storage)).toBe(0);
    expect(core.calls).toHaveLength(1);
    expect(appendLog).not.toHaveBeenCalled();
  });
});
