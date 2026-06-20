// 전송 진행 표시용 포매터/타이틀 빌더. SFTP TransferBar와 터미널 전송 토스트가
// 공유한다(무거운 SftpWorkspace 모듈을 토스트가 끌어오지 않도록 분리).

import type { TransferJob } from "@shared";

export function formatSize(size: number): string {
  if (!size) {
    return "--";
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  if (size < 1024 * 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function formatTransferSpeed(
  bytesPerSecond?: number | null,
): string | null {
  if (!bytesPerSecond || bytesPerSecond <= 0) {
    return null;
  }
  return `${formatSize(bytesPerSecond)}/s`;
}

export function formatEta(seconds?: number | null): string | null {
  if (!seconds || seconds <= 0) {
    return null;
  }
  if (seconds < 60) {
    return `남은 시간 ${seconds}초`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) {
    return remainder > 0
      ? `남은 시간 ${minutes}분 ${remainder}초`
      : `남은 시간 ${minutes}분`;
  }
  const hours = Math.floor(minutes / 60);
  const minuteRemainder = minutes % 60;
  return minuteRemainder > 0
    ? `남은 시간 ${hours}시간 ${minuteRemainder}분`
    : `남은 시간 ${hours}시간`;
}

export function buildTransferDirection(job: TransferJob): string {
  return `${job.sourceLabel} -> ${job.targetLabel}`;
}

export function buildTransferCardTitle(job: TransferJob): string {
  const firstRequestedItemName = job.request?.items[0]?.name?.trim();
  if (firstRequestedItemName) {
    if (job.itemCount > 1) {
      return `${firstRequestedItemName} 외 ${job.itemCount - 1}개`;
    }
    return firstRequestedItemName;
  }

  if (job.activeItemName) {
    return job.activeItemName;
  }

  return buildTransferDirection(job);
}

export function getTransferFailureDisplayMessage(job: TransferJob): string {
  if (job.failedItemCount && job.failedItemCount > 0) {
    return `${job.failedItemCount}개 항목 전송에 실패했습니다.`;
  }
  return job.errorMessage?.trim() || "전송에 실패했습니다.";
}
