import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAiToolHelpers } from './host-exec-helpers';

// AI 의 읽기전용 조회 도구를 어느 세션에 내줄지. 못 하는 세션에 내주면 AI 가 그걸 부르고
// 실패를 사용자에게 보여 준다 — 안 내주면 터미널에 직접 넣는 길로 간다.

function helpersFor(transport: string | undefined) {
  return buildAiToolHelpers({
    coreManager: {
      getSessionTransport: () => transport,
      listTabs: () => [],
      runInTerminalCapture: vi.fn(),
      runCommand: vi.fn(),
    } as never,
    hosts: {} as never,
    activityLogs: {} as never,
  });
}

const platform = process.platform;

function setPlatform(value: string) {
  Object.defineProperty(process, 'platform', { configurable: true, value });
}

afterEach(() => {
  setPlatform(platform);
});

describe('AI 조회 도구를 내줄 세션', () => {
  it('원격 SSH 는 플랫폼과 무관하게 내준다 — 저쪽이 유닉스다', () => {
    setPlatform('win32');
    expect(helpersFor('ssh').canExecCapture?.('session-1')).toBe(true);
  });

  it('로컬 셸은 유닉스에서만 내준다', () => {
    setPlatform('darwin');
    expect(helpersFor('local-shell').canExecCapture?.('session-1')).toBe(true);
    setPlatform('linux');
    expect(helpersFor('local-shell').canExecCapture?.('session-1')).toBe(true);
  });

  it('윈도우의 로컬 셸에는 내주지 않는다 — /bin/sh 가 없어 호출이 실패한다', () => {
    setPlatform('win32');
    expect(helpersFor('local-shell').canExecCapture?.('session-1')).toBe(false);
  });

  it('모르는 통로에는 내주지 않는다', () => {
    setPlatform('darwin');
    expect(helpersFor('serial').canExecCapture?.('session-1')).toBe(false);
    expect(helpersFor(undefined).canExecCapture?.('session-1')).toBe(false);
  });
});
