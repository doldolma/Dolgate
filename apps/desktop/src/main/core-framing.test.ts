import { describe, expect, it } from 'vitest';
import {
  CoreFrameParser,
  encodeControlFrame,
  encodeStreamFrame,
  type ParsedFrame,
  type ParsedStreamFrame
} from './core-framing';

describe('core framing', () => {
  it('parses a control frame only after the full payload arrives', () => {
    const parser = new CoreFrameParser();
    const frame = encodeControlFrame({
      type: 'connected',
      sessionId: 'session-1',
      payload: {
        transport: 'ssh'
      }
    });

    expect(parser.push(frame.subarray(0, 6))).toEqual([]);

    const parsed = parser.push(frame.subarray(6));
    expect(parsed).toEqual([
      {
        kind: 'control',
        metadata: {
          type: 'connected',
          sessionId: 'session-1',
          payload: {
            transport: 'ssh'
          }
        }
      }
    ]);
  });

  it('parses multiple stream and control frames in order', () => {
    const parser = new CoreFrameParser();
    const control = encodeControlFrame({
      type: 'status',
      payload: {
        status: 'ready'
      }
    });
    const stream = encodeStreamFrame(
      {
        type: 'data',
        sessionId: 'session-1'
      },
      new Uint8Array(Buffer.from('hello\r\n', 'utf8'))
    );

    const parsed = parser.push(Buffer.concat([control, stream]));
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({
      kind: 'control',
      metadata: {
        type: 'status',
        payload: {
          status: 'ready'
        }
      }
    });
    expect(parsed[1]).toEqual({
      kind: 'stream',
      metadata: {
        type: 'data',
        sessionId: 'session-1'
      },
      payload: new Uint8Array(Buffer.from('hello\r\n', 'utf8'))
    });
  });

  it('throws when it encounters an unknown frame kind', () => {
    const parser = new CoreFrameParser();
    const broken = Buffer.from(encodeControlFrame({ type: 'status', payload: {} }));
    broken.writeUInt8(255, 0);

    expect(() => parser.push(broken)).toThrow('Unknown core frame kind: 255');
  });
});

describe('CoreFrameParser reassembly', () => {
  it('rebuilds a frame that arrives in many chunks', () => {
    // 사이드카 stdout 은 64KiB 씩 끊겨 온다. 예전 구현은 청크마다 전체를 다시 복사해서, 한 프레임
    // 조립 비용이 크기의 제곱으로 커졌다 — 화면 한 장짜리 갱신에서 메인 프로세스가 초 단위로
    // 묶이고 그동안 클릭 IPC 가 밀렸다.
    const payload = Buffer.alloc(64 * 1024 * 5, 7);
    const frame = encodeStreamFrame(
      { type: 'rdpFrame', sessionId: 's1' } as never,
      payload,
    );

    const parser = new CoreFrameParser();
    const collected: ParsedFrame[] = [];
    for (let offset = 0; offset < frame.length; offset += 64 * 1024) {
      collected.push(...parser.push(frame.subarray(offset, offset + 64 * 1024)));
    }

    expect(collected).toHaveLength(1);
    const parsed = collected[0];
    expect(parsed.kind).toBe('stream');
    if (parsed.kind === 'stream') {
      expect(parsed.payload.length).toBe(payload.length);
      expect(parsed.payload[0]).toBe(7);
      expect(parsed.payload.at(-1)).toBe(7);
    }
  });

  it('keeps frames separate when several arrive in one chunk', () => {
    const first = encodeStreamFrame(
      { type: 'rdpFrame', sessionId: 'a' } as never,
      Buffer.from([1, 2, 3]),
    );
    const second = encodeStreamFrame(
      { type: 'rdpFrame', sessionId: 'b' } as never,
      Buffer.from([4, 5]),
    );

    const parser = new CoreFrameParser();
    const frames = parser.push(Buffer.concat([first, second]));

    expect(frames).toHaveLength(2);
    expect(frames.map((frame) => (frame as ParsedStreamFrame).metadata.sessionId)).toEqual(['a', 'b']);
  });

  it('does not let one frame overwrite the next one still in the buffer', () => {
    // 백업 저장소를 재사용하므로 payload 가 사본이 아니면 뒤 프레임이 앞 프레임의 픽셀을 덮는다.
    const first = encodeStreamFrame(
      { type: 'rdpFrame', sessionId: 'a' } as never,
      Buffer.from([1, 1, 1, 1]),
    );
    const second = encodeStreamFrame(
      { type: 'rdpFrame', sessionId: 'b' } as never,
      Buffer.from([9, 9, 9, 9]),
    );

    const parser = new CoreFrameParser();
    const frames = parser.push(Buffer.concat([first, second]));
    parser.push(encodeStreamFrame({ type: 'rdpFrame', sessionId: 'c' } as never, Buffer.alloc(4, 3)));

    expect([...(frames[0] as ParsedStreamFrame).payload]).toEqual([1, 1, 1, 1]);
  });

  it('handles a frame split across a chunk boundary mid-header', () => {
    const frame = encodeStreamFrame(
      { type: 'rdpFrame', sessionId: 'a' } as never,
      Buffer.from([1, 2, 3, 4]),
    );

    const parser = new CoreFrameParser();
    // 헤더 9바이트 한가운데에서 끊는다.
    expect(parser.push(frame.subarray(0, 4))).toHaveLength(0);
    expect(parser.push(frame.subarray(4))).toHaveLength(1);
  });
});
