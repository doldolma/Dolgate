// 전송 진행 표시용 포매터/타이틀 빌더. SFTP TransferBar와 터미널 전송 토스트가
// 공유한다(무거운 SftpWorkspace 모듈을 토스트가 끌어오지 않도록 분리).

import type { TransferEndpointRef, TransferJob } from "@shared";
import { t } from '../i18n';

/** 받는 폴더 줄에 보일 너비 한도(한글·한자는 2칸으로 센다). 카드 폭 360px 의 작은 글씨 한 줄. */
const TRANSFER_FOLDER_DISPLAY_WIDTH = 38;
const WIDE_CHARACTER = /[ᄀ-ᇿ⺀-鿿가-힯豈-﫿＀-￯]/;

function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    width += WIDE_CHARACTER.test(character) ? 2 : 1;
  }
  return width;
}

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
    return t('transferFmt.etaSeconds', { seconds });
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) {
    return remainder > 0
      ? t('transferFmt.etaMinutesSeconds', { minutes, seconds: remainder })
      : t('transferFmt.etaMinutes', { minutes });
  }
  const hours = Math.floor(minutes / 60);
  const minuteRemainder = minutes % 60;
  return minuteRemainder > 0
    ? t('transferFmt.etaHoursMinutes', { hours, minutes: minuteRemainder })
    : t('transferFmt.etaHours', { hours });
}

export function buildTransferDirection(job: TransferJob): string {
  return `${job.sourceLabel} -> ${job.targetLabel}`;
}

/**
 * 전송 카드에 보일 폴더 경로. 로컬 홈은 `~` 로 줄이고, 그래도 길면 가운데를 줄여 끝의 폴더 이름이 남게 한다
 * (`~/…/스터디/최적화`). 어디로 받았는지가 카드에 보이지 않아, 엉뚱한 폴더로 들어가도 알 수 없었다.
 */
export function formatTransferFolderPath(
  path: string,
  homePath?: string | null,
  maxWidth = TRANSFER_FOLDER_DISPLAY_WIDTH,
): string {
  const separator = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  const home = homePath?.replace(/[\\/]+$/, "");
  let display = path;
  if (home && (path === home || path.startsWith(`${home}${separator}`))) {
    display = `~${path.slice(home.length)}`;
  }
  if (displayWidth(display) <= maxWidth) {
    return display;
  }
  const parts = display.split(separator);
  if (parts.length <= 3) {
    return display;
  }
  const head = parts[0];
  let tail = [parts[parts.length - 1]];
  for (let index = parts.length - 2; index >= 1; index -= 1) {
    const candidate = [head, "…", parts[index], ...tail].join(separator);
    if (displayWidth(candidate) > maxWidth) {
      break;
    }
    tail = [parts[index], ...tail];
  }
  if (tail.length >= parts.length - 1) {
    return display;
  }
  return [head, "…", ...tail].join(separator);
}

/** 받는 폴더. 요청 정보가 없는 작업(옛 기록 등)은 null. */
export function getTransferTargetFolder(job: TransferJob): string | null {
  return job.request?.target.path || null;
}

/** 전송 카드에 커서를 올리면 보일 보낸 곳·받는 곳 전체 경로. 요청 정보가 없으면 null. */
export function buildTransferPathTooltip(job: TransferJob): string | null {
  const request = job.request;
  if (!request) {
    return null;
  }
  const describe = (endpoint: TransferEndpointRef, label: string) =>
    endpoint.kind === "local" ? endpoint.path : `${label}:${endpoint.path}`;
  return [
    `${t('transferFmt.pathFrom')} ${describe(request.source, job.sourceLabel)}`,
    `${t('transferFmt.pathTo')} ${describe(request.target, job.targetLabel)}`,
  ].join("\n");
}

export function buildTransferCardTitle(job: TransferJob): string {
  const firstRequestedItemName = job.request?.items[0]?.name?.trim();
  if (firstRequestedItemName) {
    if (job.itemCount > 1) {
      return t('transferFmt.andMore', { name: firstRequestedItemName, count: job.itemCount - 1 });
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
    return t('transferFmt.failedItems', { count: job.failedItemCount });
  }
  return job.errorMessage?.trim() || t('core.transferFailed');
}
