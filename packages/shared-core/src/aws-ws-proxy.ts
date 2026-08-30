/**
 * 서버 프록시 SSH 전송.
 *
 * **서버가 셸을 여는 것이 아니라, SSH 바이트를 실어 나르는 것이다.** 앱은 SSM 터널을 직접 열
 * 수 없는 자리(IP 가 제한된 VPC, 자격증명을 들고 AWS 를 부를 수 없는 클라이언트)에서 sync-api
 * 에게 그 일을 맡기고, SSH 연결 자체는 여전히 이쪽 ssh-core 안에 둔다.
 *
 * 그 차이가 기능을 가른다. SSH 연결이 이쪽에 있으면 보조 exec 채널을 열 수 있어 동적 완성·
 * SFTP·포트포워딩이 그대로 되지만, 서버가 SSM 셸을 열어 화면만 중계하면 PTY 하나가 전부라
 * 그 무엇도 안 된다.
 */
export interface AwsSshTunnelStartMessage {
  region: string;
  profileName: string;
  instanceId: string;
  availabilityZone: string;
  sshUsername: string;
  sshPort: number;
  /** EIC 임시 공개키. 서버가 이것을 인스턴스에 밀어 넣는다(개인키는 이쪽에 남는다). */
  publicKey: string;
  /** 서버가 AWS 를 부를 때 쓸 자격증명 환경. 프록시를 켠다는 것은 이것을 보낸다는 뜻이다. */
  env: Record<string, string>;
  unsetEnv?: string[];
}

/**
 * ssh-core 가 대상에 직접 다이얼하는 대신 이 웹소켓으로 전송을 태운다. `startMessage` 는 첫
 * 프레임으로 그대로 전달되고, 그 뒤로는 평범한 SSH 바이트가 흐른다.
 */
export interface WsProxyTarget {
  url: string;
  authToken?: string;
  startMessage: AwsSshTunnelStartMessage;
}

export function buildAwsSshTunnelWsUrl(serverUrl: string): string {
  const url = new URL('/api/aws-ssh-tunnel/ws', serverUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

/**
 * 토큰은 URL 이 아니라 Bearer 헤더로 간다(WsProxyTarget.authToken) — 접속 주소는 로그·프록시에
 * 남을 수 있는 값이라 거기에 자격을 싣지 않는다.
 */
export function buildAwsWsProxyTarget(input: {
  serverUrl: string;
  accessToken: string;
  startMessage: AwsSshTunnelStartMessage;
}): WsProxyTarget {
  return {
    url: buildAwsSshTunnelWsUrl(input.serverUrl),
    authToken: input.accessToken,
    startMessage: input.startMessage,
  };
}

/**
 * 서버 프록시 웹소켓이 자격을 거절했는가.
 *
 * ssh-core 는 이 실패를 `dial: ... (http 401)` 로 올린다 — HTTP 응답이 아니라 다이얼 오류의
 * 문구라, 보통의 401 판정기가 잡지 못한다. 별도로 판정하는 이유는 뒤처리가 다르기 때문이다:
 * 인스턴스 쪽 문제는 기억해 두고 한동안 SSH 를 건너뛰지만, 만료된 토큰은 갱신하고 다시
 * 시도해야 한다. 둘을 섞으면 다시 로그인한 뒤에도 한동안 약한 경로로만 붙는다.
 */
export function isServerProxyAuthRejection(message: string): boolean {
  return /\(http (401|403)\)/.test(message);
}
