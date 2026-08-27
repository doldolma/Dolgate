// 연결 실패 원인 분류. 여기서는 코드만 돌려주고 문구는 각 앱이 붙인다 — 데스크톱·모바일이
// 공유하는 패키지라 UI 언어를 결정할 수 없다(shared-core 의 다른 검증 함수들과 같은 규칙).
//
// 코어가 올려 보내는 오류는 대부분 Go 원문이다. 분류하지 않으면 "context deadline exceeded"
// 같은 문장이 그대로 화면에 뜬다.
//
// 문구가 세 계통으로 온다는 점이 중요하다. 원인이 같아도 표현이 다르다.
//   1. 리눅스·맥의 OS 소켓 dial — Go 의 표준 문구("connection refused")
//   2. tailnet 경유 dial — tsnet 의 사용자 공간 스택(gvisor netstack)이 주는 문구
//      ("connection was refused")
//   3. 윈도우의 OS 소켓 dial — winsock 오류를 FormatMessage 가 풀어 쓴 문장("connectex: No
//      connection could be made because the target machine actively refused it")
// 그래서 각 분류가 세 표현을 모두 받아야 한다. 윈도우 문구는 문장 구조가 달라서 다른 두 계통의
// 패턴에 하나도 걸리지 않는다("connection refused" 라는 표현이 아예 없다) — 놓치면 unknown 으로
// 떨어져 Go 원문이 그대로 화면에 뜬다.
//
// **이제 코어가 두 가지를 함께 올려 준다**(services/ssh-core 의 internal/neterr, 두 Rust 코어의
// core_framing::neterr): errno 로 판정한 원인 코드(`ErrorPayload.failure`)와, 1번 계통으로 접은
// 정경 문구. 문구를 함께 접어 주는 이유는 이미 배포된 앱이 그 문구만 알기 때문이고, 코드를 함께
// 싣는 이유는 우리가 처음 보는 OS 문구(로케일 폴백, 새 플랫폼)여도 원인을 알 수 있어야 하기
// 때문이다.
//
// 그래서 아래 문구 규칙은 여전히 필요하다 — 구버전 코어, 코드를 싣지 않는 경로(문자열만 남은 IPC
// 오류), 그리고 소켓보다 구체적인 원인(tailnet·호스트 키·IAM)은 문구에만 있다. 판정 순서는
// getConnectionFailureReason 에 적어 두었다.

export type ConnectionFailureCode =
  | "account-auth-rejected"
  | "account-required"
  | "address-in-use"
  | "agent-unreachable"
  | "auth-rejected"
  | "aws-auth"
  | "aws-permission"
  | "cancelled"
  | "certificate-declined"
  | "certificate-undecided"
  | "dns-unresolved"
  | "host-key-declined"
  | "host-key-untrusted"
  | "no-route"
  | "password-required"
  | "password-truncated"
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
  /**
   * 거부된 IAM 액션 이름(`ssm:StartSession` 등). aws-permission 일 때만 채워진다.
   *
   * 문구에 이 값을 끼워 넣어야 사용자가 할 일이 정해진다 — "권한이 없습니다"만으로는
   * 어느 정책을 고쳐야 하는지 알 수 없고, 원문(영어 ARN 한 줄)을 그대로 보여주면 읽지 않는다.
   */
  awsAction?: string;
}

/** 코어가 이벤트 payload 에 실어 보내는 것 중 이 판정에 쓰는 값. */
export interface ConnectionFailureSignals {
  /**
   * 코어가 판정한 소켓 원인 코드(`ErrorPayload.failure`).
   *
   * 코어는 errno 를 보고 이것을 채운다 — 문구·로케일과 무관하다(services/ssh-core 의
   * internal/neterr, 두 Rust 코어의 core_framing::neterr). 우리가 처음 보는 OS 문구여도 원인은
   * 알 수 있다는 뜻이라, 아래 문구 규칙이 아무것도 못 찾았을 때의 폴백으로 쓴다.
   */
  failure?: string | null;
}

/**
 * 코어가 **스스로 판정해 실어 보내는** 코드. 여기 없는 값은 추측하지 않고 버린다.
 *
 * 두 계층이 섞여 있다:
 *   - 소켓: errno 로 판정한다(services/ssh-core 의 internal/neterr, 두 Rust 코어의
 *     core_framing::neterr).
 *   - 인증: 프로토콜 자체가 알려 주는 실패다(services/vnc-core 의 src/failure.rs). 서버가 붙인
 *     거부 사유는 서버가 정하는 문장이라 문구 규칙으로는 판정할 수 없다 — 코드만이 안다.
 */
const CORE_FAILURE_CODES = new Set<ConnectionFailureCode>([
  "account-auth-rejected",
  "account-required",
  "address-in-use",
  "auth-rejected",
  "dns-unresolved",
  "no-route",
  "password-required",
  "password-truncated",
  "refused",
  "reset",
  "timeout",
]);

/** 코드만으로 실패를 판정할 때 붙일 계층. 문구 규칙이 붙이는 것과 같아야 한다. */
const LAYER_BY_CODE: Partial<
  Record<ConnectionFailureCode, ConnectionFailureLayer>
> = {
  timeout: "ssh",
};

/**
 * AWS 오류 문장에서 거부된 IAM 액션 이름을 뽑는다.
 *
 * AWS 는 세 가지 표현을 쓴다:
 *   - `User: arn:… is not authorized to perform: ssm:StartSession on resource: …`
 *   - `… because no identity-based policy allows the ssm:StartSession action`
 *   - 액션만 문장에 들어 있는 짧은 변형(SDK·서비스마다 다르다)
 *
 * 마지막 폴백은 서비스 접두사를 알고 있는 것만 받는다. `service:Action` 모양을 아무거나
 * 받으면 문장 안의 ARN(`arn:aws:sts::…`)까지 액션으로 읽는다 — 액션의 첫 글자가 대문자라는
 * 규칙만으로도 대부분 걸러지지만, 접두사를 못 박아 두는 편이 확실하다.
 */
export function extractAwsIamAction(message: string): string | null {
  const patterns: RegExp[] = [
    /not authorized to (?:perform|access):?\s*([a-z][a-z0-9-]*:[A-Za-z][A-Za-z0-9_*]*)/i,
    /policy allows the ([a-z][a-z0-9-]*:[A-Za-z][A-Za-z0-9_*]*) action/i,
    /\b((?:ssm|ssmmessages|ec2|ec2messages|ec2-instance-connect|kms|ecs|sts|iam|cloudshell):[A-Z][A-Za-z0-9_*]*)/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(message);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
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
  // --- 사용자가 스스로 그만둔 것 ---
  //
  // 실패로 분류하지만 성질이 다르다: 다시 시도해도 같고, 자격증명을 다시 넣어도 풀리지 않는다.
  // 이 두 줄이 없으면 아래 타임아웃·리셋 규칙에도 안 걸려 "unknown" 으로 떨어져서 원문이 그대로
  // 화면에 뜨고, 데스크톱의 재연결·자격증명 판정이 "ssh handshake failed" 만 보고 각각 자동
  // 재연결과 비밀번호 재입력 창을 띄웠다 — 신뢰를 거절한 사용자에게 둘 다 할 일이 아니다.
  {
    pattern: /host key was not trusted/i,
    code: "host-key-declined",
    layer: "hostKey",
  },
  {
    pattern:
      /challenge was cancelled|prompt was cancelled|context canceled|no answer came back in time/i,
    code: "cancelled",
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
  // IAM 권한 부족. **aws-auth 뒤**에 둔다 — 두 실패의 할 일이 정반대다(저쪽은 다시 로그인,
  // 이쪽은 정책 수정). 만료된 토큰을 AccessDenied 로 돌려주는 응답도 있어서, 만료를 먼저
  // 판정해야 "다시 로그인" 안내를 잃지 않는다.
  //
  // 우리가 직접 만든 한국어 안내("… 권한을 확인해 주세요")는 일부러 잡지 않는다 — 이미 그
  // 상황에 맞게 쓴 문장이라, 여기서 잡으면 더 구체적인 안내를 일반 문구로 덮는다. SSH 의
  // "permission denied" 도 넣지 않는다 — 그것은 IAM 이 아니라 계정 인증 실패다.
  {
    pattern:
      /not authorized to (?:perform|access)|no identity-based policy allows|\baccessdenied\b|accessdeniedexception|\bunauthorizedoperation\b/i,
    code: "aws-permission",
  },
  // 이름을 못 찾은 것은 경로가 없는 것과 할 일이 다르다 — 주소·DNS·hosts 를 봐야 한다.
  // 윈도우는 "No such host is known."(WSAHOST_NOT_FOUND), 유닉스 계열은 getaddrinfo 문구를 준다.
  {
    pattern:
      /no such host|no such host is known|name or service not known|nodename nor servname/i,
    code: "dns-unresolved",
  },
  {
    // "host is down", "machine is not on the network" 는 gvisor netstack 쪽 표현이고,
    // "unreachable host|network"(WSAEHOSTUNREACH·WSAENETUNREACH), "host was down"
    // (WSAEHOSTDOWN) 은 윈도우 쪽 표현이다.
    pattern:
      /network is unreachable|no route to host|host (is|was) down|machine is not on the network|unreachable (host|network)/i,
    code: "no-route",
  },
  // gvisor 는 "connection was refused" 다 — "was" 때문에 예전 패턴이 통째로 새어 나갔다.
  // 윈도우(WSAECONNREFUSED)는 문장 자체가 다르다 — "No connection could be made because the
  // target machine actively refused it". sshd 포트를 옮긴 호스트에 예전 포트로 붙으면 이 문구다.
  {
    pattern: /connection (was )?refused|actively refused it/i,
    code: "refused",
  },
  // --- RDP·VNC 코어(rdp-core)의 인증서 판정 ---
  //
  // **아래 timeout 규칙보다 앞이어야 한다.** rdp-core 의 문장이 "timed out waiting for the
  // certificate decision" 이어서 timeout 에 먼저 걸리면 "호스트가 응답하지 않는다" 로 뒤바뀐다
  // — 실제로는 사용자가 인증서 승인을 안 눌러서 한도를 넘긴 것이고, 할 일이 정반대다.
  {
    pattern: /waiting for the certificate decision/i,
    code: "certificate-undecided",
    layer: "hostKey",
  },
  {
    pattern: /(server )?certificate was not trusted/i,
    code: "certificate-declined",
    layer: "hostKey",
  },
  // context deadline exceeded 는 Go 의 ctx 만료가 그대로 올라온 것이다(tailnet 경유 dial 이
  // 예산을 다 쓴 경우 등). 분류하지 않으면 원문이 화면에 뜬다.
  //
  // 윈도우(WSAETIMEDOUT)는 "timed out" 이라는 표현 없이 한 문장으로 풀어 쓴다 — "A connection
  // attempt failed because the connected party did not properly respond after a period of
  // time, or established connection failed because connected host has failed to respond".
  // OS 의 TCP 재시도 한도가 우리 dial 예산보다 먼저 끝나면 이 문구가 온다.
  {
    pattern:
      /i\/o timeout|timed out|operation timed out|context deadline exceeded|deadline exceeded|did not properly respond|failed to respond/i,
    code: "timeout",
    layer: "ssh",
  },
  // "broken pipe" 는 이미 닫힌 소켓에 쓴 경우다(유닉스 EPIPE) — 사용자에게는 같은 "끊겼다" 다.
  // "connection aborted" 도 gvisor 쪽 표현이다. 윈도우는 "An existing connection was forcibly
  // closed by the remote host"(WSAECONNRESET), "An established connection was aborted by the
  // software in your host machine"(WSAECONNABORTED) 로 온다 — 뒤쪽은 "was" 때문에 예전 패턴에서
  // 새어 나갔다.
  {
    pattern: /connection (was )?(reset|aborted)|forcibly closed|broken pipe|\bEOF\b/i,
    code: "reset",
  },
  // 포트 포워딩이 로컬 리스너를 열지 못한 경우(`open local listener: listen tcp …: bind: …`).
  // 원격이 아니라 **이 컴퓨터**의 포트가 이미 쓰이고 있다는 뜻이라 사용자가 할 일이 다르다.
  // 윈도우의 Go 는 같은 상황에 다른 문장을 준다("Only one usage of each socket address …").
  {
    pattern:
      /address already in use|only one usage of each socket address|EADDRINUSE/i,
    code: "address-in-use",
  },
];

/**
 * 다시 붙어 볼 만한 원인. 자동 재연결·조용한 재시도 판단이 이 집합을 쓴다.
 *
 * **정책을 한 곳에 둔다.** 예전에는 같은 판정이 네 곳(화면 문구·자동 재연결·SSM 재시도·SFTP
 * 진단)에 각자의 정규식으로 있었고, 윈도우 문구 계통이 늘었을 때 네 곳이 따로 새고 따로 고쳐야
 * 했다.
 *
 * dns-unresolved 는 넣지 않는다 — 이름이 틀린 것은 다시 붙어도 같고, 주소를 고치는 것이 할 일이다.
 * address-in-use 도 아니다 — 이 컴퓨터의 포트가 막힌 것이라 재연결이 풀어 주지 않는다.
 */
const TRANSIENT_CODES = new Set<ConnectionFailureCode>([
  "no-route",
  "refused",
  "reset",
  "timeout",
]);

/**
 * 이 실패가 "다시 붙어 보면 될지도" 인지. 판정할 수 없으면 false — 모르는 실패를 재연결 대상으로
 * 단정하지 않는다(호출부가 보수적으로 몇 번만 시도하게 남겨 둔다).
 */
export function isTransientConnectionFailure(
  message: string,
  signals?: ConnectionFailureSignals,
): boolean {
  return TRANSIENT_CODES.has(getConnectionFailureReason(message, signals).code);
}

/**
 * 실패 원인을 판정한다.
 *
 * **문구 규칙이 먼저다.** 코어가 실어 보내는 `failure` 는 소켓 계층의 원인이고, 문장에는 그보다
 * 구체적인 원인이 들어 있을 수 있다 — tailnet 등록 만료, 호스트 키 거절, IAM 권한 부족은 모두
 * 소켓이 거부당한 것과 같은 자리에서 나타나지만 사용자가 할 일이 완전히 다르다. 코드를 먼저
 * 믿으면 "연결이 거부됐습니다" 로 덮어 그 안내를 잃는다.
 *
 * 코드는 **문구로 아무것도 못 찾았을 때** 쓴다. 우리가 처음 보는 OS 문구(로케일 폴백, 새 플랫폼)
 * 여도 코어는 errno 로 원인을 알고 있으니, 원문을 그대로 내보내는 대신 그 코드를 쓴다.
 */
export function getConnectionFailureReason(
  message: string,
  signals?: ConnectionFailureSignals,
): ConnectionFailureReason {
  const normalized = message.trim();
  if (!normalized) {
    return coreReason(signals) ?? { code: "unknown" };
  }
  for (const rule of RULES) {
    if (!rule.pattern.test(normalized)) {
      continue;
    }
    const reason: ConnectionFailureReason = { code: rule.code };
    if (rule.layer) {
      reason.layer = rule.layer;
    }
    if (rule.code === "aws-permission") {
      const awsAction = extractAwsIamAction(normalized);
      if (awsAction) {
        reason.awsAction = awsAction;
      }
    }
    return reason;
  }
  return coreReason(signals) ?? { code: "unknown" };
}

/** 코어가 실어 보낸 코드를 판정 결과로 바꾼다. 모르는 값이면 null — 추측하지 않는다. */
function coreReason(
  signals: ConnectionFailureSignals | undefined,
): ConnectionFailureReason | null {
  const failure = signals?.failure?.trim();
  if (!failure) {
    return null;
  }
  const code = failure as ConnectionFailureCode;
  if (!CORE_FAILURE_CODES.has(code)) {
    return null;
  }
  const layer = LAYER_BY_CODE[code];
  return layer ? { code, layer } : { code };
}
