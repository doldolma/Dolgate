import type { SliceDeps, ZmodemSlice } from "../types";
import { upsertTransferJob } from "../utils";

// 취소 콜백 레지스트리. ZMODEM 컨트롤러는 pane 컨트롤러의 ref에 있어 store에서 직접
// 세션을 abort할 수 없다. 컨트롤러가 jobId별 abort 함수를 등록해 두면 cancel 액션이
// 이를 찾아 호출한다(terminal-write-registry와 같은 결의 모듈 레지스트리).
const abortByJobId = new Map<string, () => void>();

export function registerZmodemAbort(jobId: string, abort: () => void): void {
  abortByJobId.set(jobId, abort);
}

export function clearZmodemAbort(jobId: string): void {
  abortByJobId.delete(jobId);
}

export function createZmodemSlice(deps: SliceDeps): ZmodemSlice {
  const { set } = deps;
  return {
    zmodemTransfers: [],
    upsertZmodemTransfer: (job) =>
      set((state) => ({
        zmodemTransfers: upsertTransferJob(state.zmodemTransfers, job),
      })),
    cancelZmodemTransfer: (jobId) => {
      abortByJobId.get(jobId)?.();
      set((state) => ({
        zmodemTransfers: state.zmodemTransfers.map((job) =>
          job.id === jobId && job.status === "running"
            ? { ...job, status: "cancelling" }
            : job,
        ),
      }));
    },
    dismissZmodemTransfer: (jobId) =>
      set((state) => ({
        zmodemTransfers: state.zmodemTransfers.filter(
          (job) => job.id !== jobId,
        ),
      })),
  };
}
