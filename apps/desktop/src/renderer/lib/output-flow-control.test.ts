import { describe, expect, it, vi } from 'vitest';
import {
  createOutputFlowControl,
  OUTPUT_ACK_STEP_BYTES,
  OUTPUT_HEARTBEAT_MS,
  OUTPUT_HIDDEN_BACKLOG_BYTES,
} from './output-flow-control';

function setup(options: { pending?: number; visible?: boolean } = {}) {
  const state = { pending: options.pending ?? 0, visible: options.visible ?? true, now: 0 };
  const deps = {
    start: vi.fn(),
    ack: vi.fn(),
    stop: vi.fn(),
    pendingBytes: () => state.pending,
    isVisible: () => state.visible,
    setHidden: vi.fn(),
    now: () => state.now,
  };
  const flow = createOutputFlowControl(deps);
  return { flow, deps, state };
}

describe('출력 흐름 제어(렌더러)', () => {
  it('만들 때 켜고, 버릴 때 끈다', () => {
    const { flow, deps } = setup();
    expect(deps.start).toHaveBeenCalledTimes(1);
    flow.dispose();
    flow.dispose();
    expect(deps.stop).toHaveBeenCalledTimes(1);
  });

  // 키 하나의 에코마다 알리면 초당 수천 번 IPC 가 오간다. 상한(1MB)에 닿으려면 한참 남았으니 모아서 알린다.
  it('처리한 양이 한 단위에 못 미치면 알리지 않는다', () => {
    const { flow, deps } = setup();
    flow.received(100);
    flow.settle();
    expect(deps.ack).not.toHaveBeenCalled();
  });

  it('처리한 양을 단위가 찰 때마다 알린다', () => {
    const { flow, deps, state } = setup();
    flow.received(OUTPUT_ACK_STEP_BYTES * 3);
    state.pending = OUTPUT_ACK_STEP_BYTES * 3;
    flow.settle();
    expect(deps.ack).not.toHaveBeenCalled();

    state.pending = OUTPUT_ACK_STEP_BYTES;
    flow.settle();
    expect(deps.ack).toHaveBeenLastCalledWith(OUTPUT_ACK_STEP_BYTES * 2);

    state.pending = 0;
    flow.settle();
    expect(deps.ack).toHaveBeenLastCalledWith(OUTPUT_ACK_STEP_BYTES);
    expect(deps.ack).toHaveBeenCalledTimes(2);
  });

  // ZMODEM 이 삼킨 바이트는 화면 대기분에 들어가지 않는다. 받은 즉시 처리한 것으로 쳐야 `sz` 다운로드가
  // 멈추지 않는다.
  it('화면에 넘기지 않고 삼킨 출력은 받은 즉시 처리한 것으로 친다', () => {
    const { flow, deps } = setup({ pending: 0 });
    flow.received(OUTPUT_ACK_STEP_BYTES);
    flow.settle();
    expect(deps.ack).toHaveBeenCalledWith(OUTPUT_ACK_STEP_BYTES);
  });

  // 스냅샷 복원·안내 문구도 런타임 큐에 들어가 대기분이 받은 양보다 클 수 있다. 처리한 양이 거꾸로 가면 안 된다.
  it('대기분이 받은 양보다 커도 알린 양을 되돌리지 않는다', () => {
    const { flow, deps, state } = setup();
    flow.received(OUTPUT_ACK_STEP_BYTES);
    flow.settle();
    expect(deps.ack).toHaveBeenCalledWith(OUTPUT_ACK_STEP_BYTES);

    state.pending = OUTPUT_ACK_STEP_BYTES * 10;
    flow.settle();
    expect(deps.ack).toHaveBeenCalledTimes(1);
  });

  // 숨은 창은 xterm 처리가 초당 1MB 아래로 떨어진다. 그대로 알리면 백그라운드 빌드가 그 속도로 묶인다.
  it('창이 안 보이면 쌓인 것이 한도 아래인 동안 받은 즉시 처리한 것으로 친다', () => {
    const { flow, deps, state } = setup({ pending: OUTPUT_ACK_STEP_BYTES * 4, visible: false });
    flow.received(OUTPUT_ACK_STEP_BYTES * 4);
    flow.settle();
    expect(deps.ack).toHaveBeenCalledWith(OUTPUT_ACK_STEP_BYTES * 4);

    // 다시 보이면 실제 대기분으로 센다. 숨은 동안 알린 것은 되돌리지 않는다.
    state.visible = true;
    flow.received(OUTPUT_ACK_STEP_BYTES);
    flow.settle();
    expect(deps.ack).toHaveBeenCalledTimes(1);
  });

  // 숨은 동안 쏟아지면 메모리가 끝없이 늘었다(10초에 369MB). 한도를 넘는 만큼은 알리지 않아 코어가 멈춘다.
  it('창이 안 보여도 쌓인 것이 한도를 넘으면 넘는 만큼은 알리지 않는다', () => {
    const over = OUTPUT_ACK_STEP_BYTES * 3;
    const { flow, deps, state } = setup({
      pending: OUTPUT_HIDDEN_BACKLOG_BYTES + over,
      visible: false,
    });
    flow.received(OUTPUT_HIDDEN_BACKLOG_BYTES + over);
    flow.settle();
    expect(deps.ack).toHaveBeenCalledWith(OUTPUT_HIDDEN_BACKLOG_BYTES);

    // 처리가 따라잡아 한도 아래로 내려가면 나머지를 알린다.
    state.pending = OUTPUT_HIDDEN_BACKLOG_BYTES;
    flow.settle();
    expect(deps.ack).toHaveBeenLastCalledWith(over);
  });

  // 창이 다시 보일 때 쌓인 출력을 그리는 동안은 처리한 양이 단위에 못 미쳐도, 코어가 렌더러가 사라진
  // 것으로 오해하지 않게 살아 있음을 알린다.
  it('처리 중인데 한동안 알리지 못했으면 살아 있음을 알린다', () => {
    const { flow, deps, state } = setup({ pending: OUTPUT_ACK_STEP_BYTES * 8 });
    flow.received(OUTPUT_ACK_STEP_BYTES * 8 + 10);
    state.now = OUTPUT_HEARTBEAT_MS - 1;
    flow.settle();
    expect(deps.ack).not.toHaveBeenCalled();

    state.now = OUTPUT_HEARTBEAT_MS;
    flow.settle();
    expect(deps.ack).toHaveBeenCalledWith(10);

    state.now = OUTPUT_HEARTBEAT_MS * 2;
    flow.settle();
    expect(deps.ack).toHaveBeenLastCalledWith(0);
  });

  // 숨은 창은 타이머가 1분에 한 번으로 줄어 위의 살아 있음 알림도 그만큼 뜸해진다. 코어가 그 사이
  // 렌더러가 사라진 것으로 보고 풀지 않게, 숨고 보이는 것을 따로 알린다.
  it('보이는 창은 만들 때 숨김을 알리지 않는다', () => {
    const { deps } = setup();
    expect(deps.setHidden).not.toHaveBeenCalled();
  });

  it('숨은 창은 만들 때 알리고, 바뀔 때만 다시 알린다', () => {
    const { flow, deps, state } = setup({ visible: false });
    // 코어는 구독(start) 때 보이는 창으로 시작하므로 숨김은 그 뒤에 알려야 한다.
    expect(deps.start.mock.invocationCallOrder[0]).toBeLessThan(deps.setHidden.mock.invocationCallOrder[0]);
    expect(deps.setHidden).toHaveBeenCalledTimes(1);
    expect(deps.setHidden).toHaveBeenLastCalledWith(true);

    flow.settle();
    expect(deps.setHidden).toHaveBeenCalledTimes(1);

    state.visible = true;
    flow.settle();
    expect(deps.setHidden).toHaveBeenCalledTimes(2);
    expect(deps.setHidden).toHaveBeenLastCalledWith(false);

    state.visible = false;
    flow.settle();
    expect(deps.setHidden).toHaveBeenLastCalledWith(true);
    expect(deps.setHidden).toHaveBeenCalledTimes(3);
  });

  it('버린 뒤에는 세지도 알리지도 않는다', () => {
    const { flow, deps } = setup();
    flow.dispose();
    flow.received(OUTPUT_ACK_STEP_BYTES * 2);
    flow.settle();
    expect(deps.ack).not.toHaveBeenCalled();
  });
});
