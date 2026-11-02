import { describe, expect, it } from 'vitest';
import { buildCsv, csvCell, formatCsvTime } from './csv';

describe('csv', () => {
  it('quotes cells with commas, quotes and line breaks', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell('cr\rin the middle')).toBe('"cr\rin the middle"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(0)).toBe('0');
  });

  it('keeps text from running as a spreadsheet formula', () => {
    for (const start of ['=', '+', '-', '@', '\t']) {
      expect(csvCell(`${start}cmd`)).toBe(`'${start}cmd`);
    }
    // 막은 뒤에도 따옴표 규칙은 그대로다.
    expect(csvCell('=HYPERLINK("x","y")')).toBe(`"'=HYPERLINK(""x"",""y"")"`);
    expect(csvCell('\rcmd')).toBe(`"'\rcmd"`);
    // 숫자는 숫자 그대로, 가운데의 = 는 그대로.
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell('a=b')).toBe('a=b');
  });

  it('starts with a BOM and ends every line with CRLF', () => {
    expect(
      buildCsv(
        ['A', 'B'],
        [
          ['1', 2],
          [null, 'x,y'],
        ],
      ),
    ).toBe('﻿A,B\r\n1,2\r\n,"x,y"\r\n');
  });

  it("writes times in this device's time zone and leaves unreadable ones as they are", () => {
    const local = new Date(2026, 10, 2, 9, 5, 7);
    expect(formatCsvTime(local.toISOString())).toBe('2026-11-02 09:05:07');
    expect(formatCsvTime(null)).toBe('');
    expect(formatCsvTime('')).toBe('');
    expect(formatCsvTime('not a time')).toBe('not a time');
  });
});
