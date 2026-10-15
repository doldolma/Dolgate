// 실제 lrzsz 0.12.21(Ubuntu 20.04) 의 sz 가 보낸 바이트(조각 그대로, base64). 수신 쪽은 앱과 같은 라이브러리
// (nora-zmodemjs)로 응답해 녹음했다. 파일 내용에는 ZDLE·XON·XOFF·0x91·0x93 처럼 이스케이프되는 바이트가 섞여 있다.

/** a.bin(600바이트). */
export const LRZSZ_FILE_A = 'ByZFZIOiweD/Hj1ce5q52PcWNVRzkrHQ7w4tTGuKqcjnBiVEY4KhwN/+HTxbepm41/YVNFNykbDP7g0sS2qJqMfmBSRDYoGgv979HDtaeZi31vUUM1JxkK/O7QwrSmmIp8blBCNCYYCfvt38GzpZeJe21fQTMlFwj67N7AsqSWiHpsXkAyJBYH+evdz7GjlYd5a11PMSMVBvjq3M6wopSGeGpcTjAiFAX36dvNv6GThXdpW00/IRME9ujazL6gkoR2aFpMPiASA/Xn2cu9r5GDdWdZSz0vEQL05tjKvK6QgnRmWEo8LhAB8+XXybutn4FzZVdJOy0fAPLk1si6rJ6AcmRWSDosHg/x49XHuaudj3FjVUc5Kx0O8OLUxriqnI5wYlRGOCocDf/h08W3qZuNf2FTRTcpGwz+4NLEtqiajH5gUkQ2KBoL/e/Rw7WnmYt9b1FDNScZCvzu0MK0ppiKfG5QQjQmGAn77d/Bs6WXiXttX0EzJRcI+uzewLKkloh6bF5AMiQWB/nr3c+xo5WHeWtdTzEjFQb46tzOsKKUhnhqXE4wIhQF9+nbzb+hk4V3aVtNPyETBPbo2sy+oJKEdmhaTD4gEgP159nLva+Rg3VnWUs9LxEC9ObYyryukIJ0ZlhKPC4QAfPl18m7rZ+Bc2VXSTstHwDy5NbIuqyegHJkVkg6LB4P8ePVx7mrnY9xY1VHOSsdDvDi1Ma4qpyOcGJURjgqHA3/4dPFt6mbjX9hU0U3KRsM/uDSxLaomox+YFJENigaC/3v0cO1p5mLfW9RQzUnGQ';

/**
 * `sz a.bin` 을 PTY 로 돌렸을 때(실제 터미널처럼). ZFIN 으로 끝나고 "OO" 는 오지 않는다 — 앱에서 본 것과
 * 같다(파이프로 돌리면 "OO" 가 온다).
 */
export const LRZSZ_SZ_A_PTY: readonly string[] = [
  'cnoNKioYQjAwMDAwMDAwMDAwMDAwDYoR',
  'KhhDBAAAAADdUaIzYS5iaW4ANjAwIDE1MjY0MDU2NTMwIDEwMDY0NCAwIDEgNjAwABhr13Y4TBE=',
  'KhhDCgAAAAC875KMByZFZIOiweD/Hj1ce5q52PcWNVRzkrHQ7w4tTGuKqcjnBiVEY4KhwN/+HTxbepm41/YVNFNyGNGwz+4NLEtqiajH5gUkQ2KBoL/e/Rw7WnmYt9b1FDNScRjQr87tDCtKaYinxuUEI0JhgJ++3fwbOll4l7bV9BhTMlFwj67N7AsqSWiHpsXkAyJBYH+evdz7GjlYd5a11PMSMVBvjq3M6wopSGeGpcTjAiFAX36dvNv6GThXdpW00/IYUTBPbo2sy+oJKEdmhaTD4gEgP159nLva+RhYN1Z1lLPS8RhQL05tjKvK6QgnRmWEo8LhAB8+XXybutn4FzZVdBjTstHwDy5NbIuqyegHJkVkg6LB4P8ePVx7mrnY9xY1VHOSsdDvDi1Ma4qpyOcGJURjgqHA3/4dPFt6mbjX9hU0U3IY0bDP7g0sS2qJqMfmBSRDYoGgv979HDtaeZi31vUUM1JxGNCvzu0MK0ppiKfG5QQjQmGAn77d/Bs6WXiXttX0GFMyUXCPrs3sCypJaIemxeQDIkFgf5693PsaOVh3lrXU8xIxUG+OrczrCilIZ4alxOMCIUBffp282/oZOFd2lbTT8hhRME9ujazL6gkoR2aFpMPiASA/Xn2cu9r5GFg3VnWUs9LxGFAvTm2Mq8rpCCdGZYSjwuEAHz5dfJu62fgXNlV0GNOy0fAPLk1si6rJ6AcmRWSDosHg/x49XHuaudj3FjVUc5Kx0O8OLUxriqnI5wYlRGOCocDf/h08W3qZuNf2FTRTchjRsM/uDSxLaomox+YFJENigaC/3v0cO1p5mLfW9RQzUnEY0BhomiY1VioYQwtYAgAALzXPvA==',
  'DSoqGEIwODAwMDAwMDAwMDIyZA2K',
];

/** b.bin(400바이트). */
export const LRZSZ_FILE_B = 'CypJaIemxeQDIkFgf5693PsaOVh3lrXU8xIxUG+OrczrCilIZ4alxOMCIUBffp282/oZOFd2lbTT8hEwT26NrMvqCShHZoWkw+IBID9efZy72vkYN1Z1lLPS8RAvTm2Mq8rpCCdGZYSjwuEAHz5dfJu62fgXNlV0k7LR8A8uTWyLqsnoByZFZIOiweD/Hj1ce5q52PcWNVRzkrHQ7w4tTGuKqcjnBiVEY4KhwN/+HTxbepm41/YVNFNykbDP7g0sS2qJqMfmBSRDYoGgv979HDtaeZi31vUUM1JxkK/O7QwrSmmIp8blBCNCYYCfvt38GzpZeJe21fQTMlFwj67N7AsqSWiHpsXkAyJBYH+evdz7GjlYd5a11PMSMVBvjq3M6wopSGeGpcTjAiFAX36dvNv6GThXdpW00/IRME9ujazL6gkoR2aFpMPiASA/Xn2cu9r5GDdWdZSz0vEQL05tjKvK6QgnRmWEo8LhAB8+XXybutn4FzZVdJOy0fAPLk1si6rJ6AcmRWSDosHg/x49XA==';

/** `sz b.bin` 을 파이프로 돌렸을 때. "OO" 로 끝난다. */
export const LRZSZ_SZ_B: readonly string[] = [
  'cnoNKioYQjAwMDAwMDAwMDAwMDAwDYoR',
  'KhhDBAAAAADdUaIzYi5iaW4ANDAwIDE1MjY0MDU2NTMwIDEwMDY0NCAwIDEgNDAwABhrxSjVQxE=',
  'KhhDCgAAAAC875KMCypJaIemxeQDIkFgf5693PsaOVh3lrXU8xIxUG+OrczrCilIZ4alxOMCIUBffp282/oZOFd2lbTT8hhRME9ujazL6gkoR2aFpMPiASA/Xn2cu9r5GFg3VnWUs9LxGFAvTm2Mq8rpCCdGZYSjwuEAHz5dfJu62fgXNlV0GNOy0fAPLk1si6rJ6AcmRWSDosHg/x49XHuaudj3FjVUc5Kx0O8OLUxriqnI5wYlRGOCocDf/h08W3qZuNf2FTRTchjRsM/uDSxLaomox+YFJENigaC/3v0cO1p5mLfW9RQzUnEY0K/O7QwrSmmIp8blBCNCYYCfvt38GzpZeJe21fQYUzJRcI+uzewLKkloh6bF5AMiQWB/nr3c+xo5WHeWtdTzEjFQb46tzOsKKUhnhqXE4wIhQF9+nbzb+hk4V3aVtNPyGFEwT26NrMvqCShHZoWkw+IBID9efZy72vkYWDdWdZSz0vEYUC9ObYyryukIJ0ZlhKPC4QAfPl18m7rZ+Bc2VXQY07LR8A8uTWyLqsnoByZFZIOiweD/Hj1cGGgr8EjLKhhDCxjQAQAAn01wDQ==',
  'KioYQjA4MDAwMDAwMDAwMjJkDYo=',
  'T08=',
];

export function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
