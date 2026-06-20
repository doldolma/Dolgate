import { describe, expect, it } from "vitest";
import {
  formatCommandDuration,
  formatCommandNotification,
  shouldNotifyCommandFinished,
} from "./command-notification";

const base = {
  commandNotificationsEnabled: true,
  commandNotificationThresholdSeconds: 30,
  commandNotificationOnlyWhenUnfocused: true,
  commandNotificationOnFailure: true,
  commandNotificationSound: false,
};

describe("shouldNotifyCommandFinished", () => {
  it("기능이 꺼져 있으면 알리지 않는다", () => {
    expect(
      shouldNotifyCommandFinished(
        { ...base, commandNotificationsEnabled: false },
        { command: "x", exitCode: 0, durationMs: 999_999, visibleToUser: false },
      ),
    ).toBe(false);
  });

  it("임계 시간을 넘고 보고 있지 않으면 알린다", () => {
    expect(
      shouldNotifyCommandFinished(base, {
        command: "build",
        exitCode: 0,
        durationMs: 31_000,
        visibleToUser: false,
      }),
    ).toBe(true);
  });

  it("짧고 성공한 명령은 알리지 않는다", () => {
    expect(
      shouldNotifyCommandFinished(base, {
        command: "ls",
        exitCode: 0,
        durationMs: 200,
        visibleToUser: false,
      }),
    ).toBe(false);
  });

  it("실패는 시간과 무관하게 알린다", () => {
    expect(
      shouldNotifyCommandFinished(base, {
        command: "make",
        exitCode: 1,
        durationMs: 200,
        visibleToUser: false,
      }),
    ).toBe(true);
  });

  it("실패 알림 옵션이 꺼져 있으면 짧은 실패는 알리지 않는다", () => {
    expect(
      shouldNotifyCommandFinished(
        { ...base, commandNotificationOnFailure: false },
        { command: "make", exitCode: 1, durationMs: 200, visibleToUser: false },
      ),
    ).toBe(false);
  });

  it("보고 있으면(비포커스 전용) 길어도 알리지 않는다", () => {
    expect(
      shouldNotifyCommandFinished(base, {
        command: "build",
        exitCode: 0,
        durationMs: 999_999,
        visibleToUser: true,
      }),
    ).toBe(false);
  });

  it("비포커스 전용이 꺼져 있으면 보고 있어도 알린다", () => {
    expect(
      shouldNotifyCommandFinished(
        { ...base, commandNotificationOnlyWhenUnfocused: false },
        {
          command: "build",
          exitCode: 0,
          durationMs: 31_000,
          visibleToUser: true,
        },
      ),
    ).toBe(true);
  });

  it("종료 코드를 몰라도 충분히 길면 알린다", () => {
    expect(
      shouldNotifyCommandFinished(base, {
        command: "tail -f",
        exitCode: null,
        durationMs: 60_000,
        visibleToUser: false,
      }),
    ).toBe(true);
  });

  it("소요 시간을 모르고 성공으로 보이면 알리지 않는다", () => {
    expect(
      shouldNotifyCommandFinished(base, {
        command: "x",
        exitCode: 0,
        durationMs: null,
        visibleToUser: false,
      }),
    ).toBe(false);
  });
});

describe("formatCommandDuration", () => {
  it("null/음수는 빈 문자열", () => {
    expect(formatCommandDuration(null)).toBe("");
    expect(formatCommandDuration(-5)).toBe("");
  });

  it("1분 미만은 초", () => {
    expect(formatCommandDuration(5_000)).toBe("5초");
  });

  it("분과 초", () => {
    expect(formatCommandDuration(90_000)).toBe("1분 30초");
    expect(formatCommandDuration(120_000)).toBe("2분");
  });

  it("시간과 분", () => {
    expect(formatCommandDuration(3_600_000)).toBe("1시간");
    expect(formatCommandDuration(3_900_000)).toBe("1시간 5분");
  });
});

describe("formatCommandNotification", () => {
  it("성공: 제목은 호스트, 본문은 명령·완료·소요시간", () => {
    const { title, body } = formatCommandNotification({
      hostLabel: "prod-web",
      command: "npm run build",
      exitCode: 0,
      durationMs: 30_000,
    });
    expect(title).toBe("prod-web");
    expect(body).toBe("npm run build · 완료 · 30초");
  });

  it("실패: exit 코드를 본문에 표시", () => {
    const { body } = formatCommandNotification({
      hostLabel: "prod-web",
      command: "make",
      exitCode: 2,
      durationMs: 1_000,
    });
    expect(body).toContain("실패 (exit 2)");
  });

  it("명령어를 모르면 상태로 시작", () => {
    const { body } = formatCommandNotification({
      hostLabel: "prod-web",
      command: null,
      exitCode: 0,
      durationMs: 45_000,
    });
    expect(body).toBe("완료 · 45초");
  });

  it("호스트가 없으면 '터미널'", () => {
    const { title } = formatCommandNotification({
      hostLabel: "",
      command: "x",
      exitCode: 0,
      durationMs: 1_000,
    });
    expect(title).toBe("터미널");
  });
});
