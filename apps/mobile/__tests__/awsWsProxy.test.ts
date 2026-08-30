import {
  buildAwsSshTunnelWsUrl,
  buildAwsWsProxyTarget,
} from '@dolssh/shared-core';

// 서버 프록시를 켜도 SSH 연결은 이 기기에 선다 — 서버는 SSM 터널과 EIC 키만 맡는다. 그 약속이
// 이 타깃의 모양에 담겨 있고, 데스크톱(aws-ws-proxy.ts)과 **같은 것**을 써야 두 앱이 갈리지 않는다.
describe('AWS SSH 터널 프록시 타깃', () => {
  it('https 서버는 wss 로 바꾼다', () => {
    expect(buildAwsSshTunnelWsUrl('https://sync.example.com')).toBe(
      'wss://sync.example.com/api/aws-ssh-tunnel/ws',
    );
  });

  it('http 서버는 ws 로 바꾼다', () => {
    expect(buildAwsSshTunnelWsUrl('http://localhost:8080')).toBe(
      'ws://localhost:8080/api/aws-ssh-tunnel/ws',
    );
  });

  it('서버 주소에 경로가 붙어 있어도 엔드포인트로 간다', () => {
    expect(buildAwsSshTunnelWsUrl('https://example.com/sync/')).toBe(
      'wss://example.com/api/aws-ssh-tunnel/ws',
    );
  });

  // 접속 주소는 로그·중간 프록시에 남을 수 있는 값이다. 토큰은 Bearer 헤더로만 간다.
  it('토큰을 주소에 싣지 않는다', () => {
    const target = buildAwsWsProxyTarget({
      serverUrl: 'https://sync.example.com',
      accessToken: 'secret-token',
      startMessage: {
        region: 'ap-northeast-2',
        profileName: 'prod',
        instanceId: 'i-0123',
        availabilityZone: 'ap-northeast-2a',
        sshUsername: 'ubuntu',
        sshPort: 22,
        publicKey: 'ssh-ed25519 AAAA',
        env: { AWS_ACCESS_KEY_ID: 'AKIA' },
        unsetEnv: ['AWS_PROFILE'],
      },
    });
    expect(target.url).not.toContain('secret-token');
    expect(target.authToken).toBe('secret-token');
    // 서버가 이것으로 터널을 열고 키를 밀어 넣는다 — 하나라도 빠지면 서버가 할 수 있는 일이 없다.
    expect(target.startMessage).toMatchObject({
      instanceId: 'i-0123',
      availabilityZone: 'ap-northeast-2a',
      sshUsername: 'ubuntu',
      sshPort: 22,
      publicKey: 'ssh-ed25519 AAAA',
    });
    expect(target.startMessage.env.AWS_ACCESS_KEY_ID).toBe('AKIA');
  });
});
