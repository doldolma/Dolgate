// RDP 서버 인증서의 TOFU 핀 판정.
//
// RDP 서버는 거의 전부 Windows 가 자동 생성한 자체 서명 인증서를 쓴다. 보증할 CA 가 없으니
// "제3자가 이 이름을 보증하는가"는 답할 수 없는 질문이고, 대신 "지난번 그 서버가 맞는가"를
// 묻는다. mstsc(레지스트리 CertHash)와 FreeRDP(known_hosts2)도 같은 모델이다.
//
// 판정 시점이 중요하다: rdp-core 는 TLS 핸드셰이크 직후 CredSSP 직전에 멈춰 이 결과를 기다린다.
// 여기서 거절하면 비밀번호는 한 바이트도 전송되지 않는다.

import type { RdpCertificateInfo, RdpCertificatePrompt, RdpCertificateStatus } from "@shared";

export interface CertificateDecisionDeps {
  /** 이 세션이 어느 호스트로 붙는 중인지. 세션이 이미 사라졌으면 null. */
  lookupHost: (sessionId: string) => {
    hostId: string;
    label: string;
    fingerprint: string | null;
  } | null;
  /** 사용자에게 물어보고 신뢰 여부를 받는다. */
  ask: (prompt: RdpCertificatePrompt) => Promise<boolean>;
  /** 사용자가 신뢰한 지문을 호스트에 기록한다. */
  persist: (hostId: string, fingerprint: string) => void;
}

export async function decideCertificate(
  deps: CertificateDecisionDeps,
  sessionId: string,
  certificate: RdpCertificateInfo,
): Promise<boolean> {
  const host = deps.lookupHost(sessionId);
  if (!host) {
    // 어느 호스트인지 모르면 신뢰 여부를 판단할 근거가 없다.
    return false;
  }

  // 이미 신뢰한 지문과 같으면 조용히 통과한다. 매번 묻는 프롬프트는 사용자가 읽지 않고 누르게
  // 만들어, 정작 진짜 변경이 왔을 때도 통과시킨다.
  if (host.fingerprint && host.fingerprint === certificate.fingerprint) {
    return true;
  }

  const status: RdpCertificateStatus = host.fingerprint ? "changed" : "unknown";

  const accepted = await deps.ask({
    sessionId,
    hostId: host.hostId,
    hostLabel: host.label,
    status,
    certificate,
    previousFingerprint: host.fingerprint,
  });

  if (accepted) {
    deps.persist(host.hostId, certificate.fingerprint);
  }

  return accepted;
}
