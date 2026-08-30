import React from 'react';
import renderer, { act } from 'react-test-renderer';

const autocompleteResult = {
  capability: {
    status: 'ready' as const,
    shell: 'bash' as const,
    sources: ['history', 'executable', 'session-history'] as const,
  },
  snapshot: {
    shell: 'bash' as const,
    revision: 1,
    history: ['git status'],
    executables: [{ name: 'git', path: '/usr/bin/git' }],
    truncated: false,
  },
};
const degradedAutocompleteResult = {
  capability: {
    status: 'degraded' as const,
    shell: 'bash' as const,
    sources: ['session-history'] as const,
    reasonCode: 'metadata-unavailable' as const,
  },
  snapshot: null,
};
const mockPrepareSessionAutocomplete = jest.fn(
  async (
    _sessionId: string,
  ): Promise<typeof autocompleteResult | typeof degradedAutocompleteResult> =>
    autocompleteResult,
);
const mockRunSessionCompletion = jest.fn(
  async (_sessionId: string, _command: string) => ({
    stdout: '',
    truncated: false,
  }),
);

// 명령 스펙은 Go 엔진이 압축한 채로 들고 있다가 하나씩 준다(JS 번들에 넣으면 20 MB 다).
// 여기서는 그 다리만 대신한다 — 스펙 내용은 shared-core 의 채점기가 해석한다.
const mockCommandSpecs: Record<string, unknown> = {
  git: {
    name: 'git',
    subcommands: [{ name: 'checkout' }, { name: 'cherry-pick' }],
    options: [{ names: ['--quiet', '-q'], description: 'Be quiet' }],
  },
  // 제너레이터 인자는 **정적 스펙**이 표시한다(hasGenerator). 실행 모듈은 그 뒤에 온다.
  docker: {
    name: 'docker',
    subcommands: [
      { name: 'logs', args: [{ name: 'container', hasGenerator: true }] },
    ],
  },
  // 적재에서 던지는 모듈. 카탈로그 목록은 한 번만 받아 굳으므로 처음부터 넣어 둔다.
  broken: {
    name: 'broken',
    subcommands: [
      { name: 'run', args: [{ name: 'target', hasGenerator: true }] },
    ],
  },
};
const mockGetCommandSpecJson = jest.fn(async (name: string) =>
  mockCommandSpecs[name] ? JSON.stringify(mockCommandSpecs[name]) : '',
);
const mockGetCommandSpecNamesJson = jest.fn(async () =>
  JSON.stringify(Object.keys(mockCommandSpecs)),
);

// 제너레이터 모듈(Fig 스펙 + 실행 함수). 실물은 데스크톱 생성물을 Metro 별칭으로 읽지만,
// 여기서는 `docker logs <container>` 한 자리만 흉내 낸다 — 확인할 것은 "호스트에 무엇을 묻고
// 그 답을 어떻게 목록으로 만드나" 이고, 그 로직은 shared-core 의 fig-runtime 이 한다.
const mockDockerModule = {
  name: 'docker',
  subcommands: [
    {
      name: 'logs',
      args: [
        {
          name: 'container',
          generators: {
            script: ['docker', 'ps', '--format', '{{.Names}}'],
            // 실제 docker 오버라이드와 같은 모양: 넣는 값은 이름, 화면에는 이미지까지.
            postProcess: (out: string) =>
              out
                .split('\n')
                .filter(Boolean)
                .map(line => {
                  const [name, image] = line.split('\t');
                  return image
                    ? { name, displayName: `${name} (${image})` }
                    : { name };
                }),
          },
        },
      ],
    },
  ],
};

// 카탈로그는 Fig 상류를 그대로 따라오므로 적재에서 던지는 모듈이 언제든 들어올 수 있다.
// 서버 프록시 세션인가. 기본은 아니다(SSH 세션은 엔진이 통합을 직접 넣는다).
const mockInstallsIntegration = jest.fn((_sessionId: string) => false);

const mockRequireCommandModule = jest.fn((name: string) => {
  if (name === 'docker') return mockDockerModule;
  if (name === 'broken') throw new Error('document is not defined');
  return null;
});

jest.mock('../src/generated/command-spec-modules', () => ({
  hasCommandModule: (name: string) => name === 'docker' || name === 'broken',
  requireCommandModule: (name: string) => mockRequireCommandModule(name),
}));

jest.mock('../src/engine/goEngine', () => ({
  getCommandSpecJson: (name: string) => mockGetCommandSpecJson(name),
  getCommandSpecNamesJson: () => mockGetCommandSpecNamesJson(),
}));

jest.mock('../src/store/useMobileAppStore', () => ({
  prepareSessionAutocomplete: (sessionId: string) =>
    mockPrepareSessionAutocomplete(sessionId),
  runSessionCompletion: (sessionId: string, command: string) =>
    mockRunSessionCompletion(sessionId, command),
  sessionAutocompleteInstallsIntegration: (sessionId: string) =>
    mockInstallsIntegration(sessionId),
}));

import { useTerminalAutocomplete } from '../src/hooks/useTerminalAutocomplete';

type HookResult = ReturnType<typeof useTerminalAutocomplete>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => {
    resolve = next;
  });
  return { promise, resolve };
}

function Harness({
  connected,
  onResult,
  sessionId = 'session-1',
}: {
  connected: boolean;
  onResult: (result: HookResult) => void;
  sessionId?: string;
}) {
  const result = useTerminalAutocomplete({
    sessionId,
    enabled: true,
    connected,
    sendInput: jest.fn(),
  });
  onResult(result);
  return null;
}

describe('useTerminalAutocomplete', () => {
  beforeEach(() => {
    mockPrepareSessionAutocomplete.mockReset();
    mockPrepareSessionAutocomplete.mockResolvedValue(autocompleteResult);
    mockRunSessionCompletion.mockReset();
    mockRunSessionCompletion.mockResolvedValue({
      stdout: '',
      truncated: false,
    });
    mockInstallsIntegration.mockReset();
    mockInstallsIntegration.mockReturnValue(false);
  });

  // SSH 세션은 엔진이 셸 채널을 열 때 통합을 넣어 준다. 마커가 오기 전에 프로브를 보내면 셸이
  // 아직 배너를 뱉는 중일 수 있어, 마커를 본 뒤에 시작한다.
  it('마커가 오기 전에는 준비하지 않는다', async () => {
    let current: HookResult | null = null;
    await act(async () => {
      renderer.create(
        <Harness connected onResult={result => (current = result)} />,
      );
    });
    expect(mockPrepareSessionAutocomplete).not.toHaveBeenCalled();
    await act(async () => {
      current!.handleShellIntegration('B');
    });
    expect(mockPrepareSessionAutocomplete).toHaveBeenCalledWith('session-1');
  });

  // 서버 프록시 세션에는 이 기기에 그런 엔진이 없다 — 통합은 준비 요청이 서버 쪽에서 설치한다.
  // 마커를 기다리면 설치를 부를 사람이 없어 둘 다 영영 시작되지 않는다.
  it('준비가 곧 설치인 세션은 마커를 기다리지 않는다', async () => {
    mockInstallsIntegration.mockReturnValue(true);
    let current: HookResult | null = null;
    await act(async () => {
      renderer.create(
        <Harness connected onResult={result => (current = result)} />,
      );
    });
    expect(mockPrepareSessionAutocomplete).toHaveBeenCalledWith('session-1');
  });

  it('붙기 전에는 준비하지 않는다', async () => {
    mockInstallsIntegration.mockReturnValue(true);
    let current: HookResult | null = null;
    await act(async () => {
      renderer.create(
        <Harness connected={false} onResult={result => (current = result)} />,
      );
    });
    expect(current).not.toBeNull();
    expect(mockPrepareSessionAutocomplete).not.toHaveBeenCalled();
  });

  it('keeps the first line buffer when a continuation prompt starts', async () => {
    let current: HookResult | null = null;
    await act(async () => {
      renderer.create(
        <Harness connected onResult={result => (current = result)} />,
      );
    });
    await act(async () => {
      current!.handleShellIntegration('B');
    });
    act(() => {
      current!.send('echo first');
      current!.handleShellIntegration('B;2');
    });
    expect(current!.command).toBe('echo first');
    expect(current!.suggestions).toEqual([]);
  });

  it('keeps the typed buffer when a prompt redraw marker arrives without a completed command', async () => {
    let current: HookResult | null = null;
    await act(async () => {
      renderer.create(
        <Harness connected onResult={result => (current = result)} />,
      );
    });
    await act(async () => {
      // 진짜 첫 프롬프트 경계: D(완료) → A 순으로 온다.
      current!.handleShellIntegration('D;0');
      current!.handleShellIntegration('A');
    });
    act(() => {
      current!.send('git s');
    });
    expect(current!.suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ insertText: 'git status' }),
      ]),
    );

    // SIGWINCH 재드로잉(키보드 개폐 → PTY 리사이즈 → 프롬프트 재그리기)은
    // D 없이 A·B 만 재발행한다 — 타이핑 중인 버퍼와 추천이 그대로여야 한다.
    act(() => {
      current!.handleShellIntegration('A');
    });
    expect(current!.command).toBe('git s');
    expect(current!.suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ insertText: 'git status' }),
      ]),
    );
    act(() => {
      current!.handleShellIntegration('B');
    });
    expect(current!.command).toBe('git s');

    // 진짜 경계(D → A)에서는 여전히 초기화한다.
    act(() => {
      current!.handleShellIntegration('D;0');
      current!.handleShellIntegration('A');
    });
    expect(current!.command).toBe('');
  });

  it('keeps history-navigation input ambiguous across a prompt redraw', async () => {
    let current: HookResult | null = null;
    await act(async () => {
      renderer.create(
        <Harness connected onResult={result => (current = result)} />,
      );
    });
    await act(async () => {
      current!.handleShellIntegration('D;0');
      current!.handleShellIntegration('A');
    });

    act(() => {
      current!.send('\x1b[A');
      current!.handleShellIntegration('A');
      current!.handleShellIntegration('B');
      current!.send('g');
    });

    // The remote readline buffer contains a recalled history entry, while JS
    // intentionally does not know its text. A resize redraw must not turn that
    // unknown state into an exact empty buffer and offer a stale completion.
    expect(current!.command).toBe('g');
    expect(current!.suggestions).toEqual([]);
  });

  it('prepares again after reconnecting the same session record', async () => {
    let current: HookResult | null = null;
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <Harness connected onResult={result => (current = result)} />,
      );
    });
    await act(async () => {
      current!.handleShellIntegration('B');
    });
    expect(mockPrepareSessionAutocomplete).toHaveBeenCalledTimes(1);

    await act(async () => {
      tree!.update(
        <Harness connected={false} onResult={result => (current = result)} />,
      );
    });
    await act(async () => {
      tree!.update(
        <Harness connected onResult={result => (current = result)} />,
      );
    });
    expect(mockPrepareSessionAutocomplete).toHaveBeenCalledTimes(1);

    await act(async () => {
      current!.handleShellIntegration('B');
    });
    expect(mockPrepareSessionAutocomplete).toHaveBeenCalledTimes(2);
  });

  it('shows history suggestions after the shell integration prompt marker', async () => {
    let current: HookResult | null = null;
    await act(async () => {
      renderer.create(
        <Harness connected onResult={result => (current = result)} />,
      );
    });

    await act(async () => {
      current!.handleShellIntegration('B');
    });
    act(() => {
      current!.send('git s');
    });

    expect(mockPrepareSessionAutocomplete).toHaveBeenCalledTimes(1);
    expect(current!.suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          insertText: 'git status',
          source: 'history',
        }),
      ]),
    );
  });

  // 아직 쳐 본 적 없는 서브커맨드·옵션을 추천할 수 있는 것은 스펙뿐이다(히스토리에는 쳐 본
  // 것만 있다). 데스크톱은 번들에서, 모바일은 엔진에서 받아 온다 — 결과는 같아야 한다.
  it('명령 스펙으로 서브커맨드를 추천한다', async () => {
    let current: HookResult | null = null;
    await act(async () => {
      renderer.create(
        <Harness connected onResult={result => (current = result)} />,
      );
    });
    await act(async () => {
      current!.handleShellIntegration('B');
    });

    // 인자를 치기 시작해야 스펙을 받아 온다 — 받아 오는 동안 화면은 그대로 그려진다.
    await act(async () => {
      current!.send('git ch');
    });
    await act(async () => {});

    expect(mockGetCommandSpecJson).toHaveBeenCalledWith('git');
    expect(current!.suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ insertText: 'git checkout' }),
        expect.objectContaining({ insertText: 'git cherry-pick' }),
      ]),
    );
  });

  // 스펙이 없는 이름(자기 스크립트·별칭)이 대부분이다. 그때마다 다리를 건너면 키를 칠 때마다
  // 네이티브 왕복이 하나씩 늘어난다 — 목록을 먼저 받아 두고 거른다.
  // 데스크톱에서 `docker logs ` 를 치면 컨테이너 목록이 뜬다. 모바일은 제너레이터를 돌릴 길이
  // 없어 옵션만 나왔다 — 이제 같은 런타임·같은 모듈로 같은 목록을 낸다.
  it('제너레이터로 호스트에 물어 컨테이너 목록을 낸다', async () => {
    mockRunSessionCompletion.mockImplementation(async () => ({
      stdout: 'gateway\tnginx:latest\nredis\tredis:7\n',
      truncated: false,
    }));
    let current: HookResult | null = null;
    await act(async () => {
      renderer.create(
        <Harness connected onResult={result => (current = result)} />,
      );
    });
    await act(async () => {
      current!.handleShellIntegration('B');
    });

    await act(async () => {
      current!.send('docker logs ');
    });
    // 스펙이 도착하고(비동기) → 디바운스(140ms)를 지나 → 왕복이 끝나기를 기다린다.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 250));
    });
    await act(async () => {});

    // 인자는 하나씩 이스케이프돼 나가고(`'docker' 'ps'`), 앞에는 보조 채널용 PATH 가 붙는다 —
    // 데스크톱과 같은 줄이어야 같은 답이 온다(shared-core 의 buildGeneratorShellLine).
    const asked = mockRunSessionCompletion.mock.calls.map(([, cmd]) => cmd);
    expect(asked.some(cmd => cmd.includes("'docker' 'ps'"))).toBe(true);
    expect(asked.some(cmd => cmd.includes('PATH='))).toBe(true);
    // **넣는 값과 보여줄 이름이 다르다.** 넣는 것은 컨테이너 이름 하나이고, 화면에는 어느
    // 이미지인지가 함께 나와야 mysql 이 8.0인지 5.7인지 고를 수 있다.
    expect(current!.suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          insertText: 'docker logs gateway',
          displayText: 'gateway (nginx:latest)',
        }),
        expect.objectContaining({
          insertText: 'docker logs redis',
          displayText: 'redis (redis:7)',
        }),
      ]),
    );
  });

  // 적재에서 던지는 모듈이 있어도 자동완성이 죽으면 안 되고, 같은 예외를 키마다 다시 내서도
  // 안 된다 — 한 번 실패한 모듈은 기억한다.
  it('적재에서 터지는 모듈은 한 번만 시도하고 조용히 넘어간다', async () => {
    let current: HookResult | null = null;
    await act(async () => {
      renderer.create(
        <Harness connected onResult={result => (current = result)} />,
      );
    });
    await act(async () => {
      current!.handleShellIntegration('B');
    });
    mockRequireCommandModule.mockClear();

    for (const value of ['broken run a', 'broken run ab']) {
      await act(async () => {
        current!.send('\u0015');
        current!.send(value);
      });
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 250));
      });
    }

    // 살아 있고(추천 계산이 던지지 않았고), 모듈은 한 번만 불렀다.
    expect(Array.isArray(current!.suggestions)).toBe(true);
    expect(
      mockRequireCommandModule.mock.calls.filter(([n]) => n === 'broken'),
    ).toHaveLength(1);
  });

  it('스펙이 없는 명령에는 엔진을 부르지 않는다', async () => {
    let current: HookResult | null = null;
    await act(async () => {
      renderer.create(
        <Harness connected onResult={result => (current = result)} />,
      );
    });
    await act(async () => {
      current!.handleShellIntegration('B');
    });
    mockGetCommandSpecJson.mockClear();

    await act(async () => {
      current!.send('my-deploy-script --dry');
    });
    await act(async () => {});

    expect(mockGetCommandSpecJson).not.toHaveBeenCalled();
  });

  it('uses session history when exec metadata is degraded after PTY shell detection', async () => {
    const prepared = deferred<typeof degradedAutocompleteResult>();
    mockPrepareSessionAutocomplete.mockImplementationOnce(
      () => prepared.promise,
    );
    let current: HookResult | null = null;
    await act(async () => {
      renderer.create(
        <Harness connected onResult={result => (current = result)} />,
      );
    });
    await act(async () => {
      current!.handleShellIntegration('B');
    });
    expect(mockPrepareSessionAutocomplete).toHaveBeenCalledTimes(1);
    await act(async () => {
      prepared.resolve(degradedAutocompleteResult);
      await prepared.promise;
    });

    act(() => {
      current!.handleShellIntegration('C', 'git status');
      current!.handleShellIntegration('D;0');
      current!.handleShellIntegration('A');
      current!.send('git s');
    });

    expect(current!.suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          insertText: 'git status',
          source: 'history',
        }),
      ]),
    );
  });

  it("does not let an old prepare clear the new connection's in-flight work", async () => {
    const first = deferred<typeof autocompleteResult>();
    const second = deferred<typeof autocompleteResult>();
    mockPrepareSessionAutocomplete
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    let current: HookResult | null = null;
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <Harness connected onResult={result => (current = result)} />,
      );
    });
    act(() => {
      current!.handleShellIntegration('B');
    });
    await act(async () => {
      tree!.update(
        <Harness connected={false} onResult={result => (current = result)} />,
      );
    });
    await act(async () => {
      tree!.update(
        <Harness connected onResult={result => (current = result)} />,
      );
    });
    act(() => {
      current!.handleShellIntegration('B');
    });
    expect(mockPrepareSessionAutocomplete).toHaveBeenCalledTimes(2);

    await act(async () => {
      first.resolve(autocompleteResult);
      await first.promise;
    });
    act(() => {
      current!.handleShellIntegration('B');
    });
    expect(mockPrepareSessionAutocomplete).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve(autocompleteResult);
      await second.promise;
    });
  });

  it('does not cache a dynamic completion from the previous session', async () => {
    jest.useFakeTimers();
    const first = deferred<{ stdout: string; truncated: boolean }>();
    mockRunSessionCompletion
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ stdout: 'new-session/\n', truncated: false });

    let current: HookResult | null = null;
    let tree: renderer.ReactTestRenderer | null = null;
    try {
      await act(async () => {
        tree = renderer.create(
          <Harness
            connected
            sessionId="session-1"
            onResult={result => (current = result)}
          />,
        );
      });
      await act(async () => {
        current!.handleShellIntegration('B');
      });
      act(() => {
        current!.send('cd s');
      });
      await act(async () => {
        jest.advanceTimersByTime(141);
        await Promise.resolve();
      });
      expect(mockRunSessionCompletion).toHaveBeenCalledTimes(1);
      expect(mockRunSessionCompletion.mock.calls[0][0]).toBe('session-1');

      await act(async () => {
        tree!.update(
          <Harness
            connected
            sessionId="session-2"
            onResult={result => (current = result)}
          />,
        );
      });
      await act(async () => {
        first.resolve({ stdout: 'old-session/\n', truncated: false });
        await first.promise;
      });
      await act(async () => {
        current!.handleShellIntegration('B');
      });
      act(() => {
        current!.send('cd s');
      });
      await act(async () => {
        jest.advanceTimersByTime(141);
        await Promise.resolve();
      });

      expect(mockRunSessionCompletion).toHaveBeenCalledTimes(2);
      expect(mockRunSessionCompletion.mock.calls[1][0]).toBe('session-2');
    } finally {
      if (tree) {
        act(() => tree!.unmount());
      }
      jest.useRealTimers();
    }
  });
});
