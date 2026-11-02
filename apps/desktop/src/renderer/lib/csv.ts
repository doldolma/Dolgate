/** 엑셀이 한글을 깨지 않고 읽게 맨 앞에 붙이는 표시(UTF-8 BOM). */
const BOM = '﻿';
/** 엑셀이 수식으로 읽는 첫 글자 — 다른 사람이 쓴 글(호스트 이름·서버 오류)이 실행되지 않게 앞에 ' 를 붙인다. */
const FORMULA_START = /^[=+\-@\t\r]/;

export type CsvValue = string | number | null | undefined;

/** 칸 하나. 쉼표·따옴표·줄바꿈이 있으면 따옴표로 감싸고, 글은 수식으로 읽히지 않게 막는다. */
export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) {
    return '';
  }
  let text = String(value);
  if (typeof value === 'string' && FORMULA_START.test(text)) {
    text = `'${text}`;
  }
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 머리 줄과 줄들을 CSV 글로 — 줄 끝은 CRLF(RFC 4180, 엑셀). */
export function buildCsv(header: readonly string[], rows: ReadonlyArray<readonly CsvValue[]>): string {
  return `${BOM}${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/** 표에 넣는 시각 — 이 기기 시간대의 'YYYY-MM-DD HH:mm:ss'. 읽을 수 없는 값은 그대로. */
export function formatCsvTime(value: string | null | undefined): string {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
