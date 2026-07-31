import type {
  TailnetConfig,
  TailnetRecord,
  TailnetSnapshot,
  TailnetStatus,
} from '@shared';
import { desktopApi } from '../desktopApi';

export function listTailnets(): Promise<TailnetRecord[]> {
  return desktopApi.tailnet.list();
}

export function saveTailnet(
  input: Parameters<typeof desktopApi.tailnet.save>[0],
): Promise<TailnetRecord> {
  return desktopApi.tailnet.save(input);
}

export function removeTailnet(id: string): Promise<void> {
  return desktopApi.tailnet.remove(id);
}

/**
 * 이 tailnet 을 쓸 수 있게 만들라고 코어에 요청한다. 반환값은 마지막 상태다.
 *
 * 옵션이 없다. 다시 세울지·재인증을 개시할지는 코어가 링크를 확보하는 과정에서 판단한다 —
 * 화면은 상태를 그리고 의사만 전달한다.
 */
export function testTailnet(config: TailnetConfig): Promise<TailnetStatus> {
  return desktopApi.tailnet.test(config);
}

export function forgetTailnet(id: string): Promise<void> {
  return desktopApi.tailnet.forget(id);
}

export function disconnectTailnet(id: string): Promise<void> {
  return desktopApi.tailnet.disconnect(id);
}

/** 진행 중인 연결 시도를 접는다. */
export function cancelTailnet(id: string): Promise<void> {
  return desktopApi.tailnet.cancel(id);
}

/** 지금 살아 있는 노드들의 상태. 여기 없는 tailnet 은 연결돼 있지 않다. */
export function snapshotTailnets(): Promise<TailnetSnapshot> {
  return desktopApi.tailnet.snapshot();
}

/** 연결 테스트 도중의 중간 상태. 반환값으로 구독을 해제한다. */
export function onTailnetStatus(
  listener: (status: TailnetStatus) => void,
): () => void {
  return desktopApi.tailnet.onStatus(listener);
}
