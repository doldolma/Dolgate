import { useEffect, useMemo, useRef, useState } from "react";
import type { TransferJob } from "@shared";
import { cn } from "../lib/cn";
import { ArrowDown, ArrowUp, X } from "../ui/icons";
import { useAppStore } from "../store/appStore";
import { revealPath } from "../services/desktop/files";
import { isTerminalUploadJob } from "../lib/terminal-upload-registry";
import {
  buildTransferCardTitle,
  formatEta,
  formatSize,
  formatTransferSpeed,
} from "../lib/transfer-format";

type TransferKind = "zmodem" | "sftp";
interface TransferRow {
  kind: TransferKind;
  job: TransferJob;
}

const FINISHED_STATUSES = new Set(["completed", "failed", "cancelled"]);
const MAX_VISIBLE = 5;
const AUTO_HIDE_MS = 8000;

function computePercent(job: TransferJob): number {
  if (job.status === "completed") {
    return 1;
  }
  if (job.bytesTotal > 0) {
    return Math.min(1, job.bytesCompleted / job.bytesTotal);
  }
  return 0;
}

function statusLine(job: TransferJob): string {
  if (job.status === "completed") {
    return "완료";
  }
  if (job.status === "failed") {
    return job.errorMessage?.trim() || "실패";
  }
  if (job.status === "cancelled") {
    return "취소됨";
  }
  if (job.status === "cancelling") {
    return "취소 중…";
  }
  const speed = formatTransferSpeed(job.speedBytesPerSecond);
  const eta = formatEta(job.etaSeconds);
  const sizeText =
    job.bytesTotal > 0
      ? `${formatSize(job.bytesCompleted)} / ${formatSize(job.bytesTotal)}`
      : formatSize(job.bytesCompleted);
  return [sizeText, speed, eta].filter(Boolean).join(" · ");
}

// 터미널 워크스페이스용 전송 토스트: ZMODEM 다운로드(전용 slice) + 터미널발 SFTP
// 업로드(전역 transfers 중 표식된 것)를 한곳에 보여준다. 완료/실패/취소 토스트는
// 잠시 후 자동으로 숨긴다(전역 상태는 그대로 두어 SFTP 탭 기록은 유지).
export function TerminalTransferToastRegion() {
  const zmodemTransfers =
    useAppStore((state) => state.zmodemTransfers) ?? [];
  const sftpTransfers = useAppStore((state) => state.sftp?.transfers) ?? [];
  const cancelZmodemTransfer = useAppStore(
    (state) => state.cancelZmodemTransfer,
  );
  const cancelTransfer = useAppStore((state) => state.cancelTransfer);

  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set());
  const scheduledRef = useRef<Set<string>>(new Set());
  const timersRef = useRef<number[]>([]);

  useEffect(
    () => () => {
      timersRef.current.forEach((timer) => window.clearTimeout(timer));
    },
    [],
  );

  const rows = useMemo<TransferRow[]>(() => {
    const combined: TransferRow[] = [
      ...zmodemTransfers.map((job) => ({ kind: "zmodem" as const, job })),
      ...sftpTransfers
        .filter((job) => isTerminalUploadJob(job.id))
        .map((job) => ({ kind: "sftp" as const, job })),
    ];
    return combined
      .filter((row) => !hiddenIds.has(row.job.id))
      .sort((left, right) => (left.job.startedAt < right.job.startedAt ? 1 : -1))
      .slice(0, MAX_VISIBLE);
  }, [zmodemTransfers, sftpTransfers, hiddenIds]);

  const finishedSignature = rows
    .filter((row) => FINISHED_STATUSES.has(row.job.status))
    .map((row) => row.job.id)
    .join("|");

  useEffect(() => {
    for (const row of rows) {
      if (
        FINISHED_STATUSES.has(row.job.status) &&
        !scheduledRef.current.has(row.job.id)
      ) {
        const jobId = row.job.id;
        scheduledRef.current.add(jobId);
        const timer = window.setTimeout(() => {
          setHiddenIds((prev) => {
            const next = new Set(prev);
            next.add(jobId);
            return next;
          });
        }, AUTO_HIDE_MS);
        timersRef.current.push(timer);
      }
    }
    // finishedSignature가 바뀔 때만 새로 완료된 항목에 타이머를 건다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finishedSignature]);

  if (rows.length === 0) {
    return null;
  }

  const hideRow = (jobId: string) =>
    setHiddenIds((prev) => {
      const next = new Set(prev);
      next.add(jobId);
      return next;
    });

  return (
    <div className="pointer-events-none absolute bottom-3 right-3 z-30 flex w-[22rem] max-w-[calc(100%-1.5rem)] flex-col gap-2">
      {rows.map((row) => {
        const { job, kind } = row;
        const percent = computePercent(job);
        const isRunning = job.status === "running" || job.status === "queued";
        const isFinished = FINISHED_STATUSES.has(job.status);
        const savedPath =
          kind === "zmodem" && job.status === "completed"
            ? job.detailMessage
            : null;
        return (
          <div
            key={`${kind}:${job.id}`}
            className="pointer-events-auto rounded-[8px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 shadow-[var(--shadow)]"
            role="status"
          >
            <div className="flex items-center gap-2">
              <span
                className="text-xs font-semibold text-[var(--text-soft)]"
                aria-hidden
              >
                {kind === "zmodem" ? (
                  <ArrowDown className="h-3.5 w-3.5" />
                ) : (
                  <ArrowUp className="h-3.5 w-3.5" />
                )}
              </span>
              <span className="flex-1 truncate text-sm font-medium text-[var(--text)]">
                {buildTransferCardTitle(job)}
              </span>
              {isRunning && job.status !== "cancelling" ? (
                <button
                  type="button"
                  className="rounded px-1.5 py-0.5 text-xs text-[var(--text-soft)] hover:text-[var(--danger-text)]"
                  onClick={() => {
                    if (kind === "zmodem") {
                      cancelZmodemTransfer(job.id);
                    } else {
                      void cancelTransfer(job.id);
                    }
                  }}
                >
                  취소
                </button>
              ) : null}
              {isFinished ? (
                <button
                  type="button"
                  className="rounded px-1.5 py-0.5 text-xs text-[var(--text-soft)] hover:text-[var(--text)]"
                  onClick={() => hideRow(job.id)}
                  aria-label="닫기"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--text-soft)_18%,transparent)]">
              <div
                className={cn(
                  "h-full rounded-full transition-[width] duration-200",
                  job.status === "failed"
                    ? "bg-[var(--danger-text)]"
                    : "bg-[var(--accent-strong)]",
                )}
                style={{ width: `${Math.round(percent * 100)}%` }}
              />
            </div>
            <div className="mt-1 flex items-center justify-between gap-2">
              <span className="truncate text-xs text-[var(--text-soft)]">
                {statusLine(job)}
              </span>
              {savedPath ? (
                <button
                  type="button"
                  className="shrink-0 rounded px-1.5 py-0.5 text-xs text-[var(--accent-strong)] hover:underline"
                  onClick={() => {
                    void revealPath(savedPath);
                  }}
                >
                  폴더 열기
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
