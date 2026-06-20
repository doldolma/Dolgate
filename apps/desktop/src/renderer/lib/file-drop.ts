// OS 파일 드롭(드래그앤드롭) 처리용 순수 헬퍼. SFTP 패널과 터미널 패널이 공유한다.

/**
 * 드롭된 File 객체들에서 절대 경로를 추출한다.
 * Electron 렌더러는 File.path 대신 webUtils.getPathForFile로 경로를 얻는다
 * (호출자가 주입). 경로를 못 얻은 항목은 제외한다.
 */
export async function extractDroppedAbsolutePaths(
  files: Iterable<File>,
  getPathForDroppedFile: (file: File) => string | null,
): Promise<string[]> {
  const paths = await Promise.all(
    Array.from(files).map(async (file) => {
      try {
        const filePath = getPathForDroppedFile(file);
        return filePath && filePath.length > 0 ? filePath : null;
      } catch {
        return null;
      }
    }),
  );
  return paths.filter((value): value is string => Boolean(value));
}

/** 드롭 페이로드에 OS 파일이 들어있는지(내부 항목 이동이 아닌 외부 파일 드롭). */
export function hasExternalFileDrop(
  dataTransfer: Pick<DataTransfer, "files" | "types">,
): boolean {
  const types = Array.from(dataTransfer.types ?? []);
  return types.includes("Files") || dataTransfer.files.length > 0;
}
