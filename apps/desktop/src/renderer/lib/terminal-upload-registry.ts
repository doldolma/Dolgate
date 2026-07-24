// 터미널에서 시작한 SFTP 업로드 잡 id 집합. 업로드는 전역 transfers(SFTP 탭과 공유)에
// 들어가므로, 터미널 전송 토스트가 "자기 것"만 골라 표시하도록 표식해 둔다.

const terminalUploadJobIds = new Set<string>();

export function markTerminalUploadJob(jobId: string): void {
  terminalUploadJobIds.add(jobId);
}

export function isTerminalUploadJob(jobId: string): boolean {
  return terminalUploadJobIds.has(jobId);
}

// connection_lost 자동 복구로 "재수립 후 재업로드"된 잡 id. 그 재시도가 또 connection_lost
// 로 죽어도 다시 복구를 트리거하지 않게(무한 루프 방지) 표식해 둔다 — 한 번만 자동 재시도.
const autoRecoveredTransferJobIds = new Set<string>();

export function markAutoRecoveredTransferJob(jobId: string): void {
  autoRecoveredTransferJobIds.add(jobId);
}

export function isAutoRecoveredTransferJob(jobId: string): boolean {
  return autoRecoveredTransferJobIds.has(jobId);
}
