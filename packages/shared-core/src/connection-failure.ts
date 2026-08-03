// 연결 실패 원인 분류. 여기서는 코드만 돌려주고 문구는 각 앱이 붙인다 — 데스크톱·모바일이
// 공유하는 패키지라 UI 언어를 결정할 수 없다(shared-core 의 다른 검증 함수들과 같은 규칙).
//
// 코어가 올려 보내는 오류는 대부분 Go 원문이다. 분류하지 않으면 "context deadline exceeded"
// 같은 문장이 그대로 화면에 뜬다.
//
// 문구가 두 계통으로 온다는 점이 중요하다. OS 소켓으로 나간 dial 은 Go 의 표준 문구
// ("connection refused")를 주지만, tailnet 을 경유하면 tsnet 의 사용자 공간 네트워크
// 스택(gvisor netstack)이 자기 문구를 준다 — 같은 원인인데 "connection was refused" 다.
// 그래서 각 분류가 두 표현을 모두 받아야 한다.

export type ConnectionFailureCode =
  | "agent-unreachable"
  | "aws-auth"
  | "host-key-untrusted"
  | "no-route"
  | "refused"
  | "reset"
  | "tailnet-expired"
  | "tailnet-mismatch"
  | "tailnet-needs-approval"
  | "tailnet-needs-auth"
  | "timeout"
  | "unknown";

/** 실패가 어느 계층에서 났는지. 화면이 연결 단계에 실패를 붙일 때 쓴다. */
export type ConnectionFailureLayer = "hostKey" | "ssh" | "tailscale";

export interface ConnectionFailureReason {
  code: ConnectionFailureCode;
  layer?: ConnectionFailureLayer;
}

// 판정 순서가 의미를 갖는다 — 위쪽이 원인이 더 확실한 분류다. 예를 들어 tailnet 계층이
// "등록 만료"라고 알려 준 실패는 타임아웃 패턴에도 걸릴 수 있는데, 사용자가 할 일은
// 다시 로그인하는 것이라 그쪽으로 분류해야 한다.
const RULES: Array<{
  pattern: RegExp;
  code: ConnectionFailureCode;
  layer?: ConnectionFailureLayer;
}> = [
  {
    pattern: /ssh-agent (connection failed|key listing failed)/i,
    code: "agent-unreachable",
  },
  // --- Tailscale 계층이 직접 판정한 실패 ---
  {
    pattern: /node registration has expired/i,
    code: "tailnet-expired",
    layer: "tailscale",
  },
  {
    pattern: /this tailnet is not connected yet/i,
    code: "tailnet-needs-auth",
    layer: "tailscale",
  },
  {
    pattern: /waiting for administrator approval/i,
    code: "tailnet-needs-approval",
    layer: "tailscale",
  },
  {
    pattern: /connected to a different tailnet/i,
    code: "tailnet-mismatch",
    layer: "tailscale",
  },
  {
    pattern: /host key is not trusted yet/i,
    code: "host-key-untrusted",
    layer: "hostKey",
  },
  {
    pattern:
      /error when retrieving token from sso|token has expired|refresh failed|sso session.*expired|unable to locate credentials|expiredtoken|security token included in the request is invalid/i,
    code: "aws-auth",
  },
  {
    // "host is down", "machine is not on the network" 는 gvisor netstack 쪽 표현이다.
    pattern:
      /network is unreachable|no route to host|host is down|machine is not on the network/i,
    code: "no-route",
  },
  // gvisor 는 "connection was refused" 다 — "was" 때문에 예전 패턴이 통째로 새어 나갔다.
  { pattern: /connection (was )?refused/i, code: "refused" },
  // context deadline exceeded 는 Go 의 ctx 만료가 그대로 올라온 것이다(tailnet 경유 dial 이
  // 예산을 다 쓴 경우 등). 분류하지 않으면 원문이 화면에 뜬다.
  {
    pattern:
      /i\/o timeout|timed out|operation timed out|context deadline exceeded|deadline exceeded/i,
    code: "timeout",
    layer: "ssh",
  },
  // "connection aborted" 도 gvisor 쪽 표현이다.
  { pattern: /connection (reset|aborted)|\bEOF\b/i, code: "reset" },
];

export function getConnectionFailureReason(
  message: string,
): ConnectionFailureReason {
  const normalized = message.trim();
  if (!normalized) {
    return { code: "unknown" };
  }
  for (const rule of RULES) {
    if (rule.pattern.test(normalized)) {
      return rule.layer
        ? { code: rule.code, layer: rule.layer }
        : { code: rule.code };
    }
  }
  return { code: "unknown" };
}
