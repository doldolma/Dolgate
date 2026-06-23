// tmux 버전 문자열("3.0a","2.6","tmux 3.4" 등)을 비교하기 위한 작은 헬퍼.
// letter suffix(예 "3.0a"의 'a')는 무시하고 major.minor 만 본다. Go 쪽
// parseTmuxVersion/atLeast(services/ssh-core/internal/tmuxsession/version.go)와
// 동일 규칙이며, 렌더러에서는 control mode 진입을 게이트(< 2.6 → passthrough)하는 데 쓴다.

export interface ParsedTmuxVersion {
  major: number;
  minor: number;
  known: boolean;
}

export function parseTmuxVersion(input: string | undefined | null): ParsedTmuxVersion {
  const raw = (input ?? '').trim().replace(/^tmux\s+/, '').trim();
  // 선두 숫자(major), 선택적으로 ".숫자"(minor). 그 외(letter suffix 등)는 무시.
  const match = /^(\d+)(?:\.(\d+))?/.exec(raw);
  if (!match) {
    return { major: 0, minor: 0, known: false };
  }
  return {
    major: Number.parseInt(match[1], 10),
    minor: match[2] ? Number.parseInt(match[2], 10) : 0,
    known: true,
  };
}

// tmuxAtLeast 는 버전이 maj.min 이상인지 본다. 버전 미상(파싱 실패/빈 문자열)이면
// true(최신 가정) — Go 쪽 atLeast 와 동일하게, 미상일 때 control mode 를 막지 않는다.
export function tmuxAtLeast(
  version: string | undefined | null,
  maj: number,
  min: number,
): boolean {
  const v = parseTmuxVersion(version);
  if (!v.known) {
    return true;
  }
  if (v.major !== maj) {
    return v.major > maj;
  }
  return v.minor >= min;
}

// CONTROL_MODE_FLOOR: control mode(tmux -CC)를 쓸 수 있는 최소 tmux 버전. 그 미만은
// control client 사이즈 모델(refresh-client -C)이 없어(2.6 도입) passthrough 로 떨어진다.
export const CONTROL_MODE_FLOOR = { major: 2, minor: 6 } as const;

// supportsTmuxControlMode 는 감지된 버전이 control mode floor(2.6) 이상인지 본다.
// 미상이면 true(최신 가정).
export function supportsTmuxControlMode(version: string | undefined | null): boolean {
  return tmuxAtLeast(version, CONTROL_MODE_FLOOR.major, CONTROL_MODE_FLOOR.minor);
}
