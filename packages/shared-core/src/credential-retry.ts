import { isSshHostRecord } from './models';
import type { HostRecord } from './models';

// 연결이 깨졌을 때 **계정·비밀번호를 다시 받아 볼 만한가**를 판정한다. 데스크톱에서 실전으로
// 다듬은 규칙을 그대로 옮겼다 — 걸러 내는 항목마다 실제로 잘못 뜬 창이 하나씩 있다.

/**
 * 서버가 keyboard-interactive 만 받아서 실패한 것인지.
 *
 * x/crypto 는 실패 문구에 시도한 방식을 그대로 적는다:
 * `unable to authenticate, attempted methods [none keyboard-interactive], no supported methods remain`.
 * 그 목록에 password·publickey 가 없다는 것은 **서버가 그 방식을 제시하지 않았다**는 뜻이고,
 * 그러면 계정·비밀번호를 다시 받아도 보낼 곳이 없다.
 */
export function isInteractiveOnlyAuthFailure(message: string): boolean {
  const attempted = message.match(/attempted methods \[([^\]]*)\]/i)?.[1];
  if (!attempted) {
    return false;
  }
  const methods = attempted
    .split(/[\s,]+/)
    .map((method) => method.trim())
    .filter(Boolean);
  return (
    methods.includes("keyboard-interactive") &&
    !methods.includes("password") &&
    !methods.includes("publickey")
  );
}

export function resolveCredentialRetryKind(
  host: HostRecord | undefined,
  message: string,
): "auth" | null {
  if (!host || !isSshHostRecord(host)) {
    return null;
  }

  // 호스트 키 문제(불일치/미신뢰/협상 실패)는 인증(비밀번호·키) 문제가 아니라 신뢰 문제다.
  // 이런 에러 메시지엔 "ssh handshake failed"가 함께 붙는 경우가 많아, 아래 auth 패턴 검사
  // 이전에 먼저 걸러야 한다. 안 그러면 host key mismatch가 계정/비밀번호 재입력 다이얼로그를
  // 잘못 띄운다(그 입력으로는 절대 해결되지 않음 — 호스트 키 신뢰/교체 플로우가 처리할 몫).
  if (
    /host key mismatch|trusted host key|host key is not trusted|no matching host key|no common host key/i.test(
      message,
    )
  ) {
    return null;
  }

  // 사용자가 스스로 그만둔 것도 자격증명 문제가 아니다 — 호스트 키를 거절했거나, 프롬프트를 닫았거나,
  // 답하지 않아 예산이 끝난 경우다. 계정·비밀번호를 다시 넣는 것으로는 아무것도 달라지지 않는다.
  //
  // 위의 호스트 키 패턴으로는 안 걸린다: 코어의 거절 문구는 "host key **was** not trusted" 라서
  // "is not trusted" 와 어긋난다. 그 한 단어 차이로 신뢰를 거절한 사용자에게 비밀번호 창이 떴다.
  if (
    /host key was not trusted|challenge was cancelled|prompt was cancelled|context canceled|no answer came back in time/i.test(
      message,
    )
  ) {
    return null;
  }

  // 정지(타임아웃)도 자격증명 문제가 아니다. ssh-core는 정지를 "ssh handshake failed: ... i/o
  // timeout" 으로 올리는데(그 접두사는 재연결 판정이 보고 있어 바꿀 수 없다), 아래 auth 패턴에
  // "ssh handshake failed"가 들어 있어 그대로 두면 타임아웃이 계정/비밀번호 재입력 다이얼로그를
  // 띄운다. 실제로 그렇게 떴다 — 서버가 브라우저 승인을 기다리며 침묵한 경우였고, 비밀번호를
  // 다시 넣는 것으로는 절대 풀리지 않는다.
  if (
    /i\/o timeout|operation timed out|connection timed out|응답이 없습니다/i.test(
      message,
    )
  ) {
    return null;
  }

  // 서버가 keyboard-interactive 만 받는 경우다(PAM·2FA 서버가 흔히 그렇다). 계정·비밀번호를 다시
  // 넣어도 그 방식은 **시도조차 되지 않는다** — x/crypto 는 서버가 제시한 방식만 쓰고, 문구의
  // attempted methods 가 그 목록을 그대로 보여준다. 할 일은 다시 연결해 프롬프트를 받는 것이고,
  // 그건 평소 재시도 버튼이 한다.
  //
  // 판정 대상이 서버가 쓴 문장이 아니라 x/crypto 가 만든 고정 문구라는 점이 중요하다 — 서버 텍스트를
  // 해석하는 것과는 다르다.
  if (isInteractiveOnlyAuthFailure(message)) {
    return null;
  }

  if (host.authType === "keyboardInteractive") {
    return null;
  }

  if (host.authType === "password") {
    return /requires a password|password required|permission denied|unable to authenticate|authentication failed|ssh handshake failed|unexpected message type 51/i.test(
      message,
    )
      ? "auth"
      : null;
  }

  // 들어오는 오류 메시지를 판정하는 패턴이라 한국어 문구를 지우면 안 된다 — 예전
  // 메시지와 서버가 보내는 문구까지 잡아야 하므로 두 언어를 모두 유지한다.
  return /passphrase|private key|certificate|인증서|valid after|expired on|not valid before|unable to authenticate|authentication failed|ssh handshake failed|unexpected message type 51|parse private key/i.test(
    message,
  )
    ? "auth"
    : null;
}
