import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";

/** 저장 창에서 확장자 없이 이름만 넣었으면 붙인다. */
export function ensureExtension(filePath: string, extension: string): string {
  return filePath.toLocaleLowerCase().endsWith(extension)
    ? filePath
    : `${filePath}${extension}`;
}

/** 옆에 임시 파일로 쓴 뒤 이름을 바꾼다 — 쓰다 멈춰도 반쪽 파일이 남지 않는다. 나만 읽게(0600) 쓴다. */
export async function writeFileAtomically(filePath: string, content: Buffer | string): Promise<void> {
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, content, { mode: 0o600, flag: "wx" });
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}
