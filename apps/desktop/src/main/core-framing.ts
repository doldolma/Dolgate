import type { CoreEvent, CoreRequest, CoreStreamFrame } from '@shared';

const FRAME_HEADER_SIZE = 9;

export const frameKinds = {
  control: 1,
  stream: 2
} as const;

function encodeHeader(kind: number, metadataLength: number, payloadLength: number): Buffer {
  const header = Buffer.alloc(FRAME_HEADER_SIZE);
  header.writeUInt8(kind, 0);
  header.writeUInt32BE(metadataLength, 1);
  header.writeUInt32BE(payloadLength, 5);
  return header;
}

// control frame은 connect/resize/disconnect 같은 제어 메시지를 보낼 때 사용한다.
// 코어의 명령 어휘와 무관하게 control frame을 만든다. ssh-core와 rdp-core는 프레이밍만 공유하고
// 메시지 타입은 서로 다르기 때문에, 타입이 붙은 encodeControlFrame과 분리해 둔다.
export function encodeControlFrameOf(message: object): Buffer {
  const metadata = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([encodeHeader(frameKinds.control, metadata.length, 0), metadata]);
}

export function encodeControlFrame<TPayload>(message: CoreRequest<TPayload> | CoreEvent<TPayload>): Buffer {
  return encodeControlFrameOf(message);
}

// 제어 메시지에 바이너리 몫을 함께 싣는다.
//
// 마이크 PCM 처럼 **초당 수십 번 오는 바이트**를 위한 것이다. JSON 에 base64 로 담으면 실제 크기가
// 33% 늘고, 그 낭비가 세션 내내 쌓인다. 프레이밍은 이미 payload 자리를 갖고 있으므로 그것을 쓴다
// (stream frame 을 쓰지 않는 이유는 그쪽이 세션 출력 전용 경로이고, 이건 요청이기 때문이다).
export function encodeControlFrameWithPayload(message: object, payload: Uint8Array): Buffer {
  const metadata = Buffer.from(JSON.stringify(message), 'utf8');
  const payloadBuffer = Buffer.from(payload);
  return Buffer.concat([
    encodeHeader(frameKinds.control, metadata.length, payloadBuffer.length),
    metadata,
    payloadBuffer
  ]);
}

// stream frame은 터미널 바이트를 그대로 실어 나르는 hot path다.
export function encodeStreamFrame(metadata: CoreStreamFrame, payload: Uint8Array): Buffer {
  const metadataBuffer = Buffer.from(JSON.stringify(metadata), 'utf8');
  const payloadBuffer = Buffer.from(payload);
  return Buffer.concat([
    encodeHeader(frameKinds.stream, metadataBuffer.length, payloadBuffer.length),
    metadataBuffer,
    payloadBuffer
  ]);
}

export interface ParsedControlFrame {
  kind: 'control';
  metadata: CoreEvent<Record<string, unknown>>;
}

export interface ParsedStreamFrame {
  kind: 'stream';
  metadata: CoreStreamFrame;
  payload: Uint8Array;
}

export type ParsedFrame = ParsedControlFrame | ParsedStreamFrame;

/** 조립 버퍼의 시작 용량. 한 청크(64KiB)를 여유 있게 담는 크기다. */
const INITIAL_CAPACITY = 128 * 1024;

/**
 * 큰 프레임 하나를 받은 뒤 용량을 이만큼까지는 그냥 들고 있는다.
 *
 * 매번 줄이면 다음 큰 프레임에서 다시 키워야 한다. 다만 무한정 들고 있으면 화면 한 장짜리
 * 프레임(수십 MB) 뒤로 그 메모리가 세션 내내 남는다.
 */
const RETAINED_CAPACITY = 4 * 1024 * 1024;

export class CoreFrameParser {
  // 커지는 백업 저장소 + 읽기 커서.
  //
  // 예전에는 청크마다 Buffer.concat 으로 이어 붙였는데, 그러면 한 프레임을 조립하는 비용이
  // 프레임 크기의 제곱으로 커진다. 사이드카 stdout 은 64KiB 씩 끊겨 오므로 8MB 프레임이면
  // 127번의 재복사(약 520MB), 멀티모니터 전체 갱신(수십 MB)이면 초 단위로 메인 프로세스
  // 이벤트 루프가 묶인다 — 같은 스레드에 있는 입력 IPC 가 그만큼 밀린다.
  //
  // 지금은 바이트마다 한 번만 복사하고(용량이 모자랄 때만 두 배로 키운다), 소비한 만큼 커서를
  // 앞으로 민다.
  private buffer = Buffer.allocUnsafe(INITIAL_CAPACITY);
  private start = 0;
  private end = 0;

  push(chunk: Buffer): ParsedFrame[] {
    this.append(chunk);
    const frames: ParsedFrame[] = [];

    while (this.end - this.start >= FRAME_HEADER_SIZE) {
      const kind = this.buffer.readUInt8(this.start);
      const metadataLength = this.buffer.readUInt32BE(this.start + 1);
      const payloadLength = this.buffer.readUInt32BE(this.start + 5);
      const totalLength = FRAME_HEADER_SIZE + metadataLength + payloadLength;

      if (this.end - this.start < totalLength) {
        break;
      }

      const metadataStart = this.start + FRAME_HEADER_SIZE;
      const metadataEnd = metadataStart + metadataLength;
      const payloadEnd = metadataEnd + payloadLength;
      const metadataJson = this.buffer.subarray(metadataStart, metadataEnd).toString('utf8');
      // 백업 저장소는 재사용되므로 payload 는 반드시 사본이어야 한다.
      const payload = new Uint8Array(this.buffer.subarray(metadataEnd, payloadEnd));

      if (kind === frameKinds.control) {
        frames.push({
          kind: 'control',
          metadata: JSON.parse(metadataJson) as CoreEvent<Record<string, unknown>>
        });
      } else if (kind === frameKinds.stream) {
        frames.push({
          kind: 'stream',
          metadata: JSON.parse(metadataJson) as CoreStreamFrame,
          payload
        });
      } else {
        throw new Error(`Unknown core frame kind: ${kind}`);
      }

      this.start = payloadEnd;
    }

    this.reclaim();
    return frames;
  }

  private append(chunk: Buffer): void {
    const pending = this.end - this.start;
    const needed = pending + chunk.length;

    if (needed > this.buffer.length) {
      let capacity = this.buffer.length;
      while (capacity < needed) {
        capacity *= 2;
      }
      const grown = Buffer.allocUnsafe(capacity);
      this.buffer.copy(grown, 0, this.start, this.end);
      this.buffer = grown;
      this.start = 0;
      this.end = pending;
    } else if (this.end + chunk.length > this.buffer.length) {
      // 뒤에 자리가 없다. 소비한 앞부분을 접어 자리를 만든다.
      this.buffer.copy(this.buffer, 0, this.start, this.end);
      this.start = 0;
      this.end = pending;
    }

    chunk.copy(this.buffer, this.end);
    this.end += chunk.length;
  }

  private reclaim(): void {
    if (this.start !== this.end) {
      return;
    }
    this.start = 0;
    this.end = 0;
    // 큰 프레임 하나 때문에 늘어난 용량을 세션 내내 붙들지 않는다.
    if (this.buffer.length > RETAINED_CAPACITY) {
      this.buffer = Buffer.allocUnsafe(INITIAL_CAPACITY);
    }
  }
}
