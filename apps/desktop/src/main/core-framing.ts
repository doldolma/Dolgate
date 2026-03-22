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
export function encodeControlFrame<TPayload>(message: CoreRequest<TPayload> | CoreEvent<TPayload>): Buffer {
  const metadata = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([encodeHeader(frameKinds.control, metadata.length, 0), metadata]);
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

export class CoreFrameParser {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): ParsedFrame[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: ParsedFrame[] = [];

    while (this.buffer.length >= FRAME_HEADER_SIZE) {
      const kind = this.buffer.readUInt8(0);
      const metadataLength = this.buffer.readUInt32BE(1);
      const payloadLength = this.buffer.readUInt32BE(5);
      const totalLength = FRAME_HEADER_SIZE + metadataLength + payloadLength;

      if (this.buffer.length < totalLength) {
        break;
      }

      const metadataStart = FRAME_HEADER_SIZE;
      const metadataEnd = metadataStart + metadataLength;
      const payloadEnd = metadataEnd + payloadLength;
      const metadataJson = this.buffer.subarray(metadataStart, metadataEnd).toString('utf8');
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

      this.buffer = this.buffer.subarray(totalLength);
    }

    return frames;
  }
}
