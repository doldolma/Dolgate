// 팀 녹화 훑기 작업 스레드. 메인 스레드는 터미널 출력을 나르느라 바쁘다 — 출력을 한 번 더 해석하는 훑기를
// 여기서 돌린다(replay-scan-host.ts 가 띄운다).

import { parentPort } from "node:worker_threads";
import { ReplayScanSessions } from "./replay-scan-sessions";
import type { ReplayScanRequest, ReplayScanResponse } from "./replay-scan-host";

const sessions = new ReplayScanSessions();
const port = parentPort;

port?.on("message", (request: ReplayScanRequest) => {
  switch (request.type) {
    case "open":
      sessions.open(request.key, request.input);
      return;
    case "feed":
      sessions.feed(request.key, request.index, request.segment).then(
        (result) => port.postMessage({ type: "fed", id: request.id, result } satisfies ReplayScanResponse),
        (error: unknown) =>
          port.postMessage({
            type: "failed",
            id: request.id,
            message: error instanceof Error ? error.message : String(error),
          } satisfies ReplayScanResponse),
      );
      return;
    case "close":
      sessions.close(request.key);
      return;
  }
});
