import { describe, expect, it } from 'vitest';
import { consumeTailnetRelogin, requestTailnetRelogin } from './tailnet-relogin';

describe('tailnet 재확인 표시', () => {
  it('표시한 tailnet 에 대해 한 번만 참이다', () => {
    requestTailnetRelogin('net-1');

    expect(consumeTailnetRelogin('net-1')).toBe(true);
    // 두 번째는 거짓이어야 한다. 매 연결마다 확인하면 붙어 있는 노드를 매번 닫아
    // 재등록 왕복을 물린다 — 확인은 실패한 뒤의 한 번이다.
    expect(consumeTailnetRelogin('net-1')).toBe(false);
  });

  it('표시하지 않은 tailnet 은 확인하지 않는다', () => {
    expect(consumeTailnetRelogin('net-untouched')).toBe(false);
  });

  it('다른 tailnet 의 표시를 소비하지 않는다', () => {
    requestTailnetRelogin('net-a');

    expect(consumeTailnetRelogin('net-b')).toBe(false);
    expect(consumeTailnetRelogin('net-a')).toBe(true);
  });

  it('빈 id 는 표시하지 않는다', () => {
    requestTailnetRelogin('   ');

    expect(consumeTailnetRelogin('')).toBe(false);
  });
});
