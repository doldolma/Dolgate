// 연결의 **전송 계층**으로 우리가 여는 터널을 가려낸다.
//
// 사용자가 만든 포워딩 규칙이 아니라 구현 세부다. RDP-over-SSM 은 붙는 동안 SSM 터널을 하나
// 열고, VNC-over-SSH 는 SSH 터널을 하나 연다 — 세션이 끊기면 같이 닫힌다. 규칙 목록에는 없으니
// 포트 포워딩 화면에도 안 나온다.
//
// 여기 모아 두는 이유: **main 과 렌더러가 같은 답을 써야 한다.** 감사 로그(main)는 이것을
// 빼고 남기고, 사이드바 배지(렌더러)는 이것을 빼고 센다. 목록이 갈라지면 로그에는 안 남는
// 터널이 배지에는 세어져, 배지를 누르고 들어가면 아무것도 없는 화면을 보게 된다.

const INTERNAL_TRANSPORT_TUNNEL_PREFIXES = [
  'aws-ec2-ssh:', // EC2 SSH-over-SSM 전송 터널
  'aws-ec2-install-key:', // EC2 Instance Connect 임시 키 주입 터널
  'aws-sftp:', // AWS SFTP 전송 터널
  'aws-sftp-probe:', // AWS SFTP 프리플라이트 프로브 터널
  'aws-container-shell:', // 컨테이너 셸 전송 터널
  'aws-containers:', // 컨테이너 리소스 조회 터널
  // 원격 화면 세션의 전송 터널. `rdp:<sessionId>`(RDP over SSM)·`vnc:<sessionId>`(VNC over SSH
  // 터널)로 `ipc/rdp.ts`·`ipc/vnc.ts` 가 연결마다 열고 끊을 때 닫는다. 사용자가 만든 규칙은
  // randomUUID 라 이 접두사와 겹치지 않는다.
  'rdp:', // RDP-over-SSM 전송 터널
  'vnc:', // VNC-over-SSH 전송 터널
] as const;

/**
 * 이 ruleId 가 우리가 연 전송 터널인가.
 *
 * 사용자용 터널(`container-service-tunnel:`·`ecs-service-tunnel:` 및 일반 SSH/SSM 규칙)은
 * 여기 해당하지 않는다 — 그것들은 화면에도 보이고 사용자가 켜고 끈다.
 */
export function isInternalTransportTunnel(ruleId: string): boolean {
  return INTERNAL_TRANSPORT_TUNNEL_PREFIXES.some((prefix) => ruleId.startsWith(prefix));
}
