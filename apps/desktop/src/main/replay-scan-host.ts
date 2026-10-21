import { existsSync } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { SessionReplaySegment } from "@shared";
import { ReplayScanSessions, type ReplayScanFeedResult, type ReplayScanInput } from "./replay-scan-sessions";

/*
 * 팀 녹화 훑기를 어디서 돌릴지. 작업 스레드(replay-scan-worker.ts → 빌드 결과 replay-scan-worker.js)를 띄우고,
 * 못 띄우면(파일이 없거나 스레드가 죽음) 메인 스레드에서 돌린다 — 느려질 뿐 결과는 같다.
 */

export type ReplayScanRequest =
  | { type: "open"; key: string; input: ReplayScanInput }
  | { type: "feed"; id: number; key: string; index: number; segment: SessionReplaySegment }
  | { type: "close"; key: string };

export type ReplayScanResponse =
  | { type: "fed"; id: number; result: ReplayScanFeedResult }
  | { type: "failed"; id: number; message: string };

export interface ReplayScanSession {
  /** 구간을 차례로 먹인다. 훑기가 죽었으면 거절된다 — 부르는 쪽이 새로 열어 처음부터 다시 먹인다. */
  feed(index: number, segment: SessionReplaySegment): Promise<ReplayScanFeedResult>;
  close(): void;
}

export interface ReplayScanHost {
  open(input: ReplayScanInput): ReplayScanSession;
  dispose(): void;
}

let nextSessionKey = 1;

/** 메인 스레드에서 훑는다(시험, 작업 스레드를 못 띄울 때). */
export function createInProcessScanHost(): ReplayScanHost {
  const sessions = new ReplayScanSessions();
  return {
    open(input) {
      const key = `scan-${nextSessionKey++}`;
      sessions.open(key, input);
      return {
        feed: (index, segment) => sessions.feed(key, index, segment),
        close: () => sessions.close(key),
      };
    },
    dispose: () => sessions.closeAll(),
  };
}

/** 패키징된 앱에서는 app.asar 밖으로 풀어 둔 작업 스레드 파일을 쓴다. */
export function resolveReplayScanWorkerPath(directory: string): string {
  const candidate = path.join(directory, "replay-scan-worker.js");
  const unpacked = candidate.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  return unpacked !== candidate && existsSync(unpacked) ? unpacked : candidate;
}

/** 작업 스레드에서 훑는다. 스레드를 못 띄우면 메인 스레드로 물러선다. */
export function createWorkerScanHost(workerPath: string): ReplayScanHost {
  const fallback = createInProcessScanHost();
  let worker: Worker | null = null;
  let workerUnavailable = !existsSync(workerPath);
  let nextRequestId = 1;
  const pending = new Map<number, { resolve: (result: ReplayScanFeedResult) => void; reject: (error: Error) => void }>();

  const failPending = (error: Error) => {
    for (const request of pending.values()) {
      request.reject(error);
    }
    pending.clear();
  };

  const ensureWorker = (): Worker | null => {
    if (worker || workerUnavailable) {
      return worker;
    }
    try {
      const started = new Worker(workerPath);
      started.unref();
      started.on("message", (response: ReplayScanResponse) => {
        const request = pending.get(response.id);
        if (!request) {
          return;
        }
        pending.delete(response.id);
        if (response.type === "fed") {
          request.resolve(response.result);
        } else {
          request.reject(new Error(response.message));
        }
      });
      const lost = (error: Error) => {
        if (worker === started) {
          worker = null;
        }
        failPending(error);
      };
      started.on("error", (error) => {
        console.warn("[replay-scan] the scan worker failed", error);
        lost(error);
      });
      started.on("exit", (code) => lost(new Error(`replay scan worker exited (${code})`)));
      worker = started;
      return worker;
    } catch (error) {
      console.warn("[replay-scan] could not start the scan worker — scanning on the main thread", error);
      workerUnavailable = true;
      return null;
    }
  };

  return {
    open(input) {
      const active = ensureWorker();
      if (!active) {
        return fallback.open(input);
      }
      const key = `scan-${nextSessionKey++}`;
      active.postMessage({ type: "open", key, input } satisfies ReplayScanRequest);
      return {
        feed(index, segment) {
          if (worker !== active) {
            // 이 녹화를 훑던 스레드가 죽었다 — 훑기 상태가 사라졌으니 거절한다(부르는 쪽이 새로 연다).
            return Promise.reject(new Error("replay scan worker was restarted"));
          }
          const id = nextRequestId++;
          return new Promise<ReplayScanFeedResult>((resolve, reject) => {
            pending.set(id, { resolve, reject });
            active.postMessage({ type: "feed", id, key, index, segment } satisfies ReplayScanRequest);
          });
        },
        close() {
          if (worker === active) {
            active.postMessage({ type: "close", key } satisfies ReplayScanRequest);
          }
        },
      };
    },
    dispose() {
      fallback.dispose();
      failPending(new Error("replay scan host was disposed"));
      void worker?.terminate();
      worker = null;
    },
  };
}
