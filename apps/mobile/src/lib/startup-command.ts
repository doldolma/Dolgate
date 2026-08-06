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
  type SnippetRecord,
} from '@dolssh/shared-core';
import {
  parseSnippetVariables,
  type SnippetVariable,
} from './snippet-variables';

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
 * 접속 시 startup command 를 어떻게 처리할지.
 *
 * 문자열 하나가 아니라 종류를 돌려주는 이유는 스니펫 때문이다 — 변수가 있으면 값을 받아야
 * 하고, 연결된 스니펫이 사라졌으면 건너뛰되 그 사실을 호출부가 구분할 수 있어야 한다.
 */
export type StartupCommandPlan =
  | { kind: 'none' }
  /** 그대로 보낸다. */
  | { kind: 'command'; command: string }
  /** 값을 받아 치환한 뒤 보낸다. */
  | {
      kind: 'variables';
      snippetId: string;
      command: string;
      variables: SnippetVariable[];
    }
  /** 연결된 스니펫을 찾지 못했다. 접속은 그대로 진행하고 명령만 건너뛴다. */
  | { kind: 'missingSnippet' };

/**
 * 이 호스트에 보낼 startup command 를 정한다.
 *
 * `{type:'snippet'}` 은 snippets 에서 찾아 푼다. 찾지 못하면 `missingSnippet` 이다 — 접속
 * 자체를 막지는 않는다. 데스크톱에서 스니펫을 지정한 사용자가 모바일에서 접속할 때마다
 * 오류를 보는 것보다, 조용히 건너뛰고 폼에서 알려 주는 편이 낫다.
 *
 * `{type:'command'}` 의 변수는 풀지 않는다 — 데스크톱도 스니펫 경로에서만 묻는다
 * (apps/desktop/src/renderer/store/slices/sessionSlice.ts).
 */
export function resolveStartupCommand(
  host: HostRecord,
  snippets: readonly SnippetRecord[] = [],
): StartupCommandPlan {
  if (!STARTUP_COMMAND_HOST_KINDS.has(host.kind)) {
    return { kind: 'none' };
  }
  // 종류로 걸러도 타입은 좁혀지지 않는다 — aws-ecs 레코드에는 이 필드가 아예 없다.
  if (!('startupCommand' in host)) {
    return { kind: 'none' };
  }
  const configured = host.startupCommand;
  if (!configured) {
    return { kind: 'none' };
  }

  if (configured.type === 'command') {
    const command = normalizeStartupCommand(configured.command);
    return command ? { kind: 'command', command } : { kind: 'none' };
  }

  if (configured.type === 'snippet') {
    const snippet = snippets.find(entry => entry.id === configured.snippetId);
    if (!snippet) {
      return { kind: 'missingSnippet' };
    }
    const command = normalizeStartupCommand(snippet.command);
    if (!command) {
      return { kind: 'none' };
    }
    const variables = parseSnippetVariables(command);
    return variables.length > 0
      ? { kind: 'variables', snippetId: snippet.id, command, variables }
      : { kind: 'command', command };
  }

  return { kind: 'none' };
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
