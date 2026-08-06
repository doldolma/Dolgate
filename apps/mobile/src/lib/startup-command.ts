// 접속 직후 호스트에 보낼 startup command 를 고르고, 언제 보낼지 판단한다.
//
// 이 파일이 순수한 이유는 검증이다 — 프롬프트 판별은 휴리스틱이라 실기기 없이 여러 출력 모양으로
// 흘려볼 수 있어야 한다.
//
// 명령을 셸에 **타이핑**하는 방식인 것은 의도된 것이다. SSH exec 로 넣으면 명령이 셸을 대체해서
// `cd /var/log` 같은 것이 즉시 끝나고 채널이 닫힌다. 데스크톱도 같은 이유로 타이핑한다
// (apps/desktop/src/main/core-manager.ts).

import {
  MAX_HOST_STARTUP_COMMAND_LENGTH,
  type HostRecord,
} from '@dolssh/shared-core';

// 접속 직후엔 셸이 아직 프롬프트(PS1)를 안 찍었을 수 있다. 그때 보내면 커널 tty(cooked, echo on)와
// readline(raw)이 입력을 두 번 echo 한다. 그래서 "출력이 잠잠해졌고 + 꼬리가 프롬프트처럼 보일
// 때"에만 보낸다. rc 파일 sourcing 처럼 잠깐 멈추는 구간에 속으면 안 되므로 단순 디바운스로는
// 부족하다.
export const STARTUP_COMMAND_QUIET_MS = 180;
// 프롬프트를 끝내 못 알아봐도(특이한 PS1 등) 이 시간이 지나면 보낸다.
export const STARTUP_COMMAND_MAX_WAIT_MS = 2500;
// 프롬프트 판별에 들여다보는 최근 출력 길이(문자 기준).
export const STARTUP_COMMAND_TAIL_MAX_LENGTH = 256;

// startup command 를 적용하는 호스트 종류. 데스크톱과 같은 기준이다
// (apps/desktop/src/renderer/store/slices/sessionSlice.ts). ECS Exec·시리얼은 대화형 로그인 셸이
// 아니라서 제외한다.
const STARTUP_COMMAND_HOST_KINDS = new Set(['ssh', 'aws-ec2', 'warpgate-ssh']);

/** 출력 꼬리가 대화형 셸 프롬프트로 끝나는지 추정한다. 보수적으로 본다. */
export function looksLikeShellPrompt(tail: string): boolean {
  const stripped = tail
    // OSC(창 제목 설정 등): ESC ] … (BEL | ESC \)
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    // CSI(색상 등): ESC [ … final
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // 남은 단독 ESC 시퀀스
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/[ \t\r]+$/g, '');
  // 흔한 프롬프트 종결자 + oh-my-zsh/starship/powerline 의 ❯ ➜
  return /[$#%>❯➜]$/.test(stripped);
}

/** 저장된 값에서 실제로 보낼 한 줄을 만든다. 보낼 것이 없으면 null. */
export function normalizeStartupCommand(value: string | undefined): string | null {
  if (typeof value !== 'string' || value.length > MAX_HOST_STARTUP_COMMAND_LENGTH) {
    return null;
  }
  const normalized = value.replace(/\r\n?/g, '\n').replace(/\n+$/g, '');
  return normalized.trim() ? normalized : null;
}

/**
 * 이 호스트에 보낼 startup command. 없으면 null.
 *
 * `{type:'snippet'}` 은 건너뛴다 — 모바일에는 스니펫 상태가 없어서(동기화 payload 에서 개수만
 * 센다) id 를 명령으로 풀 수 없다. 조용히 넘기는 편이 낫다: 오류를 띄우면 데스크톱에서 스니펫을
 * 지정한 사용자가 모바일에서 접속할 때마다 경고를 보게 된다.
 */
export function resolveStartupCommand(host: HostRecord): string | null {
  if (!STARTUP_COMMAND_HOST_KINDS.has(host.kind)) {
    return null;
  }
  // 종류로 걸러도 타입은 좁혀지지 않는다 — aws-ecs 레코드에는 이 필드가 아예 없다.
  if (!('startupCommand' in host)) {
    return null;
  }
  const configured = host.startupCommand;
  if (configured?.type !== 'command') {
    return null;
  }
  return normalizeStartupCommand(configured.command);
}

export interface StartupCommandFlusher {
  /** 셸 출력이 도착할 때마다 부른다. */
  noteOutput: (text: string) => void;
  /** 세션이 끝나면 부른다. 남은 타이머를 정리한다. */
  dispose: () => void;
}

/** 보낼 시점을 판단하는 감시자. `send` 는 정확히 한 번만 불린다. */
export function createStartupCommandFlusher(
  send: () => void,
): StartupCommandFlusher {
  type Handle = ReturnType<typeof setTimeout>;
  let tail = '';
  let quietTimer: Handle | null = null;
  let maxWaitTimer: Handle | null = setTimeout(
    () => flush(),
    STARTUP_COMMAND_MAX_WAIT_MS,
  );
  let sent = false;

  function clearTimers(): void {
    if (quietTimer !== null) {
      clearTimeout(quietTimer);
      quietTimer = null;
    }
    if (maxWaitTimer !== null) {
      clearTimeout(maxWaitTimer);
      maxWaitTimer = null;
    }
  }

  function flush(): void {
    if (sent) {
      return;
    }
    sent = true;
    clearTimers();
    send();
  }

  return {
    noteOutput: (text: string) => {
      if (sent) {
        return;
      }
      tail = (tail + text).slice(-STARTUP_COMMAND_TAIL_MAX_LENGTH);
      if (quietTimer !== null) {
        clearTimeout(quietTimer);
      }
      quietTimer = setTimeout(() => {
        quietTimer = null;
        if (looksLikeShellPrompt(tail)) {
          flush();
        }
      }, STARTUP_COMMAND_QUIET_MS);
    },
    dispose: () => {
      sent = true;
      clearTimers();
    },
  };
}
