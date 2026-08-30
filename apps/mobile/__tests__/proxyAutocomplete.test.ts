import { createProxyAutocompleteExchange } from '../src/lib/proxy-autocomplete';

// 서버 프록시 세션의 자동완성은 한 요청에 답이 여러 통으로 온다. 그 순서가 이 왕복의 전부라,
// 규칙을 여기서 잠근다 — 틀리면 화면에는 조용히 아무것도 안 뜬다.
function makeExchange() {
  const sent: { type: string; requestId: string }[] = [];
  const exchange = createProxyAutocompleteExchange({
    send: payload => sent.push(payload),
    timeoutMs: 50,
  });
  return { exchange, sent };
}

const CAPABILITY = { status: 'ready' as const, sources: ['session-history'] };
const SNAPSHOT = { executables: [], history: [] };

describe('서버 프록시 자동완성 왕복', () => {
  it('요청을 소켓으로 보내고 requestId 를 붙인다', async () => {
    const { exchange, sent } = makeExchange();
    // 버려두면 시간이 차서 거절되고, 그 거절이 뒤이은 테스트에 가서 터진다.
    const pending = exchange.request('autocompletePrepare');
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('autocompletePrepare');
    expect(sent[0].requestId).toBeTruthy();
    exchange.rejectAll('done');
    await expect(pending).rejects.toThrow('done');
  });

  // 코어는 먼저 status:"probing" 을 requestId 없이 보낸다. 그것을 답으로 받으면 사용자는 늘
  // "준비 중" 만 보게 된다.
  it('requestId 없는 capability 는 답이 아니다', async () => {
    const { exchange } = makeExchange();
    let settled = false;
    const pending = exchange.request('autocompletePrepare').then(value => {
      settled = true;
      return value;
    });
    exchange.accept({
      type: 'autocompleteCapability',
      payload: { status: 'probing', sources: [] },
    } as never);
    await Promise.resolve();
    expect(settled).toBe(false);
    exchange.rejectAll('done');
    await expect(pending).rejects.toThrow('done');
  });

  // 스냅샷은 requestId 없이, 최종 capability 보다 먼저 온다.
  it('먼저 온 스냅샷을 최종 답에 함께 싣는다', async () => {
    const { exchange, sent } = makeExchange();
    const pending = exchange.request('autocompletePrepare');
    exchange.accept({ type: 'autocompleteSnapshot', payload: SNAPSHOT } as never);
    exchange.accept({
      type: 'autocompleteCapability',
      requestId: sent[0].requestId,
      payload: CAPABILITY,
    } as never);
    await expect(pending).resolves.toEqual({
      capability: CAPABILITY,
      snapshot: SNAPSHOT,
    });
  });

  it('스냅샷이 없어도 capability 로 매듭짓는다', async () => {
    const { exchange, sent } = makeExchange();
    const pending = exchange.request('autocompletePrepare');
    exchange.accept({
      type: 'autocompleteCapability',
      requestId: sent[0].requestId,
      payload: CAPABILITY,
    } as never);
    await expect(pending).resolves.toEqual({
      capability: CAPABILITY,
      snapshot: null,
    });
  });

  // 미결이 둘이면 requestId 없는 스냅샷의 주인을 알 수 없다. 찍으면 남의 재료를 준다.
  it('미결이 둘이면 주인 없는 스냅샷을 아무에게나 붙이지 않는다', async () => {
    const { exchange, sent } = makeExchange();
    const first = exchange.request('autocompletePrepare');
    const second = exchange.request('autocompleteRefresh');
    exchange.accept({ type: 'autocompleteSnapshot', payload: SNAPSHOT } as never);
    exchange.accept({
      type: 'autocompleteCapability',
      requestId: sent[0].requestId,
      payload: CAPABILITY,
    } as never);
    await expect(first).resolves.toEqual({
      capability: CAPABILITY,
      snapshot: null,
    });
    exchange.rejectAll('done');
    await expect(second).rejects.toThrow('done');
  });

  it('셸 상태 통은 삼키고, 남의 메시지는 넘긴다', () => {
    const { exchange } = makeExchange();
    expect(
      exchange.accept({
        type: 'autocompleteShellState',
        payload: { kind: 'shellReady', shell: 'bash' },
      } as never),
    ).toBe(true);
    expect(exchange.accept({ type: 'output', dataBase64: 'aGk=' })).toBe(false);
    expect(exchange.accept({ type: 'ready' })).toBe(false);
  });

  // 소켓이 끊겼는데 안 깨우면 훅이 시간이 다 갈 때까지 묶인다.
  it('끊기면 미결을 모두 깨운다', async () => {
    const { exchange } = makeExchange();
    const pending = exchange.request('autocompletePrepare');
    exchange.rejectAll('The AWS session was closed.');
    await expect(pending).rejects.toThrow('The AWS session was closed.');
  });

  it('답이 없으면 시간이 다 차서 실패한다', async () => {
    const { exchange } = makeExchange();
    await expect(exchange.request('autocompletePrepare')).rejects.toThrow(
      'Timed out',
    );
  });
});
