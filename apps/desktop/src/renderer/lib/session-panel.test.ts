import { describe, expect, it } from 'vitest';
import {
  buildHistoryItems,
  buildInsertPayload,
  buildShellHistoryItems,
  buildRunPayload,
  filterByQuery,
  isAtPrompt,
  resolveDefaultSessionPanelSection,
  resolveHistoryActions,
  resolveSnippetActions,
  type SessionPanelHistoryItem,
  limitListItems,
  SESSION_PANEL_LIST_LIMIT,
  splitProcessCommand,
} from './session-panel';

const AT_PROMPT = { atPrompt: true, bracketedPaste: true };

function item(
  overrides: Partial<SessionPanelHistoryItem> = {},
): SessionPanelHistoryItem {
  return {
    id: 1,
    command: 'ls -la',
    commandUnreliable: false,
    state: 'ok',
    exitCode: 0,
    durationMs: 12,
    cwd: '/srv',
    startedAt: 0,
    line: 4,
    ...overrides,
  };
}

describe('resolveHistoryActions', () => {
  it('한 줄 명령은 세 동작 모두 된다', () => {
    expect(resolveHistoryActions(item(), AT_PROMPT)).toEqual({
      canCopy: true,
      canInsert: true,
      canRun: true,
      blockedReason: null,
    });
  });

  // 여기가 이 파일의 핵심이다. 화면에서 읽은 여러 줄 명령에는 보조 프롬프트가 섞여 있다
  // (`cat <<EOF\n> line1\n> EOF`). 실행하면 셸이 멈추고, **넣기도 막는다** — 섞이는 것이
  // PS2 라 셸의 연결 프롬프트와 똑같이 보여 사용자가 알아챌 수 없다.
  it('오염된 여러 줄은 복사만 남는다', () => {
    expect(
      resolveHistoryActions(
        item({ command: 'cat <<EOF\n> line1\n> EOF', commandUnreliable: true }),
        AT_PROMPT,
      ),
    ).toEqual({
      canCopy: true,
      canInsert: false,
      canRun: false,
      blockedReason: 'unreliable',
    });
  });

  // 셸이 PS2 폭을 알려주는 세션(OSC 133;B;2)에서는 오염이 없다 — 그때는 여러 줄도 다 된다.
  it('깨끗한 여러 줄은 넣기·실행 다 된다', () => {
    expect(
      resolveHistoryActions(
        item({ command: 'cat <<EOF\nline1\nEOF', commandUnreliable: false }),
        AT_PROMPT,
      ),
    ).toEqual({
      canCopy: true,
      canInsert: true,
      canRun: true,
      blockedReason: null,
    });
  });

  it('괄호 붙여넣기가 꺼져 있으면 깨끗한 여러 줄도 복사만 남는다', () => {
    // 이때 넣으면 줄바꿈이 엔터로 작동해 줄 단위로 실행된다 — 넣기가 곧 실행이 된다.
    const actions = resolveHistoryActions(
      item({ command: 'for i in 1 2 3\ndo echo $i\ndone', commandUnreliable: false }),
      { atPrompt: true, bracketedPaste: false },
    );
    expect(actions).toEqual({
      canCopy: true,
      canInsert: false,
      canRun: true,
      blockedReason: 'needsBracketedPaste',
    });
  });

  it('행 예산을 넘겨 잘린 한 줄도 실행은 막는다', () => {
    // 잘린 앞부분도 유효한 명령일 수 있다 — "rsync … --dry-run" 에서 --dry-run 이 날아간다.
    const actions = resolveHistoryActions(
      item({ command: 'rsync -avz /srv/data host:/vol', commandUnreliable: true }),
      AT_PROMPT,
    );
    expect(actions.canInsert).toBe(true);
    expect(actions.canRun).toBe(false);
  });

  it('실행 중이면 보내지 않는다', () => {
    // 보내면 실행 중인 프로그램의 stdin 으로 들어간다.
    expect(resolveHistoryActions(item({ state: 'running' }), AT_PROMPT)).toEqual({
      canCopy: true,
      canInsert: false,
      canRun: false,
      blockedReason: 'busy',
    });
    expect(
      resolveHistoryActions(item(), { atPrompt: false, bracketedPaste: true }).canRun,
    ).toBe(false);
  });

  it('명령을 읽지 못한 항목은 복사조차 없다', () => {
    expect(resolveHistoryActions(item({ command: null }), AT_PROMPT)).toEqual({
      canCopy: false,
      canInsert: false,
      canRun: false,
      blockedReason: 'unreadable',
    });
  });
});

describe('resolveSnippetActions', () => {
  it('여러 줄 스니펫은 실행까지 된다 — 저장된 원문이라 정확하다', () => {
    const actions = resolveSnippetActions('cat <<EOF\nline1\nEOF', AT_PROMPT);
    expect(actions.canRun).toBe(true);
    expect(actions.canInsert).toBe(true);
  });

  it('여러 줄 스니펫도 넣기만 하려면 괄호 붙여넣기가 필요하다', () => {
    const actions = resolveSnippetActions('cat <<EOF\nline1\nEOF', {
      atPrompt: true,
      bracketedPaste: false,
    });
    expect(actions.canInsert).toBe(false);
    // 실행은 여전히 된다 — 줄바꿈이 엔터로 작동하는 것이 곧 사용자가 쓴 그대로다.
    expect(actions.canRun).toBe(true);
  });
});

describe('buildInsertPayload', () => {
  it('한 줄은 줄을 비우고 넣는다(엔터 없음)', () => {
    expect(buildInsertPayload('ls -la', { bracketedPaste: true })).toBe('\x15ls -la');
  });

  it('여러 줄은 괄호 붙여넣기로 감싼다', () => {
    expect(buildInsertPayload('a\nb', { bracketedPaste: true })).toBe(
      '\x15\x1b[200~a\nb\x1b[201~',
    );
  });

  it('감쌀 수 없으면 보내지 않는다', () => {
    expect(buildInsertPayload('a\nb', { bracketedPaste: false })).toBeNull();
  });

  it('넣기 페이로드에는 엔터가 없다', () => {
    expect(buildInsertPayload('ls', { bracketedPaste: true })).not.toContain('\r');
  });
});

describe('buildRunPayload', () => {
  it('줄을 비우고 넣고 엔터', () => {
    expect(buildRunPayload('ls -la')).toBe('\x15ls -la\r');
  });
});

describe('buildHistoryItems', () => {
  it('최신이 위로 오고, 읽지 못한 명령은 뺀다', () => {
    const blocks = [
      item({ id: 1, command: 'first' }),
      item({ id: 2, command: null }),
      item({ id: 3, command: 'third' }),
    ];
    expect(buildHistoryItems(blocks).map((entry) => entry.id)).toEqual([3, 1]);
  });

  it('원본 배열을 뒤집지 않는다', () => {
    // 레지스트리의 배열을 그대로 받으므로 제자리에서 뒤집으면 터미널의 블록 순서가 깨진다.
    const blocks = [item({ id: 1 }), item({ id: 2 })];
    buildHistoryItems(blocks);
    expect(blocks.map((entry) => entry.id)).toEqual([1, 2]);
  });
});

describe('filterByQuery', () => {
  it('대소문자를 가리지 않고 두 번째 줄도 찾는다', () => {
    const items = ['cat <<EOF\nSELECT 1\nEOF', 'ls -la'];
    expect(filterByQuery(items, 'select', (entry) => entry)).toEqual([items[0]]);
  });

  it('토큰이 모두 들어 있어야 통과한다(순서 무관)', () => {
    const items = ['rsync -avz /srv host:/vol', 'rsync --dry-run /tmp'];
    expect(filterByQuery(items, 'dry rsync', (entry) => entry)).toEqual([items[1]]);
  });

  it('빈 질의는 전부 돌려주되 새 배열이다', () => {
    const items = ['a'];
    const result = filterByQuery(items, '   ', (entry) => entry);
    expect(result).toEqual(items);
    expect(result).not.toBe(items);
  });
});

describe('isAtPrompt', () => {
  it('실행 중인 블록이 있으면 false', () => {
    expect(isAtPrompt([{ state: 'ok' }, { state: 'running' }])).toBe(false);
    expect(isAtPrompt([{ state: 'ok' }, { state: 'failed' }])).toBe(true);
    expect(isAtPrompt([])).toBe(true);
  });
});

describe('buildShellHistoryItems', () => {
  it('최신이 위로 오고 빈 줄은 버린다', () => {
    // 파일은 오래된 → 최신 순으로 append 된다.
    expect(
      buildShellHistoryItems(['ls', '  ', 'pwd', 'docker ps']).map((item) => item.command),
    ).toEqual(['docker ps', 'pwd', 'ls']);
  });

  // 실제 파일은 `ls`·`pwd`·`clear` 가 사이사이 섞여 수십 번 나온다 — 연달아 있는 것만 접으면
  // 목록이 그대로 그 반복으로 채워진다.
  it('떨어져 있어도 같은 명령은 최신 하나로 접는다', () => {
    expect(
      buildShellHistoryItems([
        'ls',
        'clear',
        'ls',
        'pwd',
        'clear',
        'docker ps',
      ]).map((item) => item.command),
    ).toEqual(['docker ps', 'clear', 'pwd', 'ls']);
  });

  it('몇 번 쳤는지 센다', () => {
    const items = buildShellHistoryItems(['ls', 'pwd', 'ls', 'ls']);
    expect(items.map((item) => [item.command, item.count])).toEqual([
      ['ls', 3],
      ['pwd', 1],
    ]);
  });

  it('키는 겹치지 않는다', () => {
    const items = buildShellHistoryItems(['ls', 'pwd', 'htop']);
    expect(new Set(items.map((item) => item.key)).size).toBe(items.length);
  });
});

describe('목록 상한', () => {
  it('상한 아래면 그대로 둔다', () => {
    expect(limitListItems([1, 2, 3])).toEqual({ shown: [1, 2, 3], hidden: 0 });
  });

  it('넘치면 앞에서 상한만큼 자르고 남은 수를 알려 준다', () => {
    // 셸 히스토리는 2000줄까지 온다 — 다 그리면 행마다 버튼 세 개가 붙어 앱이 버벅인다.
    const items = Array.from({ length: 2000 }, (_, index) => index);
    const { shown, hidden } = limitListItems(items);
    expect(shown).toHaveLength(SESSION_PANEL_LIST_LIMIT);
    expect(shown[0]).toBe(0);
    expect(hidden).toBe(2000 - SESSION_PANEL_LIST_LIMIT);
  });
});

describe('splitProcessCommand', () => {
  it('절대 경로면 프로그램 이름만 남기고 인자를 뗀다', () => {
    expect(splitProcessCommand('/usr/bin/node server.js --port 3000')).toEqual({
      program: 'node',
      args: 'server.js --port 3000',
    });
  });

  it('경로가 아니면 그대로 둔다 — 커널 스레드 이름이 잘리지 않게', () => {
    expect(splitProcessCommand('[kworker/0:1]')).toEqual({
      program: '[kworker/0:1]',
      args: '',
    });
    expect(splitProcessCommand('nginx: worker process')).toEqual({
      program: 'nginx:',
      args: 'worker process',
    });
  });

  /**
   * Windows 경로에는 공백이 흔하다(`C:\Program Files\…`). 첫 공백에서 자르면 프로그램이
   * `C:\Program` 이 되고 **정작 이름이 인자 칸으로 밀려난다** — 그 칸은 잘리는 자리라
   * 프로세스 목록이 `C:\Program Files\Google\Ch…` 로만 채워졌다.
   */
  it('Windows 경로는 공백으로 자르지 않고 실행 파일 이름만 남긴다', () => {
    expect(
      splitProcessCommand('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'),
    ).toEqual({ program: 'chrome.exe', args: '' });
    expect(
      splitProcessCommand('C:\\Users\\me\\IdeaProjects\\Dolgate\\node_modules\\electron\\electron.exe'),
    ).toEqual({ program: 'electron.exe', args: '' });
  });

  it('UNC 경로도 같다', () => {
    expect(splitProcessCommand('\\\\build01\\tools\\agent host.exe')).toEqual({
      program: 'agent host.exe',
      args: '',
    });
  });

  it('드라이브 루트만 있으면 그대로 둔다', () => {
    expect(splitProcessCommand('C:\\')).toEqual({ program: 'C:\\', args: '' });
  });

  it('빈 문자열도 던지지 않는다', () => {
    expect(splitProcessCommand('   ')).toEqual({ program: '', args: '' });
  });
});

describe('resolveDefaultSessionPanelSection', () => {
  // 패널을 여는 이유가 대개 "이 서버 지금 어때" 다.
  it('붙은 호스트 세션은 자원으로 시작한다', () => {
    expect(resolveDefaultSessionPanelSection('host')).toBe('resources');
  });

  // 원격 부하라는 개념이 없는 세션이다 — 자원을 열면 읽을 수 없다는 화면만 남는다.
  it('지표가 없는 세션은 이력으로 시작한다', () => {
    expect(resolveDefaultSessionPanelSection('local')).toBe('history');
    expect(resolveDefaultSessionPanelSection('serial')).toBe('history');
    expect(resolveDefaultSessionPanelSection(null)).toBe('history');
    expect(resolveDefaultSessionPanelSection(undefined)).toBe('history');
  });
});
