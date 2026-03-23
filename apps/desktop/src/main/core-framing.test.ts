import { describe, expect, it } from 'vitest';
import { CoreFrameParser, encodeControlFrame, encodeStreamFrame } from './core-framing';

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
