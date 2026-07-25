/** 블록 UI(툴바 칩·스티키 헤더)가 공유하는 소요시간 표기. */
export function formatBlockDuration(durationMs: number | null): string | null {
  if (durationMs === null || durationMs < 0) {
    return null;
  }
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }
  if (durationMs < 60_000) {
    return `${(durationMs / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}
