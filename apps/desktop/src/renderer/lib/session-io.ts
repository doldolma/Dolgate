// 터미널 세션 입력(write/resize)의 라우팅 레이어.
//
// 기본 동작은 sessionId를 ssh-core 세션으로 보고 입력을 그대로 전달하는 것이다.
// tmux control mode에서는 하나의 control 채널 위에 여러 pane이 가상 sessionId로
// 얹히므로, 컨트롤러가 pane마다 핸들러를 등록해 입력(write/resize)을 control
// 채널의 tmux 명령(send-keys / resize-pane 등)으로 우회시킨다.
//
// 핸들러가 등록되지 않은 sessionId는 종전과 100% 동일하게 동작한다.

export interface SessionIOHandler {
  write(data: string): void | Promise<void>;
  writeBinary(data: Uint8Array): void | Promise<void>;
  resize(cols: number, rows: number): void | Promise<void>;
}

const handlers = new Map<string, SessionIOHandler>();

export function registerSessionIOHandler(
  sessionId: string,
  handler: SessionIOHandler,
): void {
  handlers.set(sessionId, handler);
}

export function unregisterSessionIOHandler(sessionId: string): void {
  handlers.delete(sessionId);
}

export function resolveSessionIOHandler(
  sessionId: string,
): SessionIOHandler | undefined {
  return handlers.get(sessionId);
}
