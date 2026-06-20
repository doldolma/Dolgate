// 터미널에서 시작한 SFTP 업로드 잡 id 집합. 업로드는 전역 transfers(SFTP 탭과 공유)에
// 들어가므로, 터미널 전송 토스트가 "자기 것"만 골라 표시하도록 표식해 둔다.

const terminalUploadJobIds = new Set<string>();

export function markTerminalUploadJob(jobId: string): void {
  terminalUploadJobIds.add(jobId);
}

export function isTerminalUploadJob(jobId: string): boolean {
  return terminalUploadJobIds.has(jobId);
}
