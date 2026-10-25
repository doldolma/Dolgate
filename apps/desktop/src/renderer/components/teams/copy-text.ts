/** 클립보드에 쓴다. 창이 앞에 없거나 막혀서 쓰지 못하면 false 다 — 부른 쪽이 그렇다고 알린다. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
