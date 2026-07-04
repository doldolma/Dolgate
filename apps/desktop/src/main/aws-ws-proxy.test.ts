import { describe, expect, it, vi } from 'vitest';
import type { AwsSshTunnelStartMessage } from '@shared';
import {
  buildAwsServerProxyStartMessage,
  buildAwsSshTunnelWsUrl,
  buildAwsWsProxyTarget,
  runWithAwsServerProxyAuthRetry,
} from './aws-ws-proxy';

const startMessage: AwsSshTunnelStartMessage = {
  region: 'ap-northeast-2',
  profileName: 'prod',
  instanceId: 'i-1',
  availabilityZone: 'ap-northeast-2a',
  sshUsername: 'ec2-user',
  sshPort: 22,
  publicKey: 'ssh-ed25519 AAAA',
  env: { AWS_ACCESS_KEY_ID: 'x' },
};

describe('buildAwsSshTunnelWsUrl', () => {
  it('uses wss for https and the tunnel path', () => {
    expect(buildAwsSshTunnelWsUrl('https://sync.example.com')).toBe(
      'wss://sync.example.com/api/aws-ssh-tunnel/ws',
    );
  });

  it('uses ws for http', () => {
    expect(buildAwsSshTunnelWsUrl('http://localhost:8080')).toBe(
      'ws://localhost:8080/api/aws-ssh-tunnel/ws',
    );
  });

  it('does not embed the access token in the URL (ssh-core uses a Bearer header)', () => {
    expect(buildAwsSshTunnelWsUrl('https://x.com')).not.toContain('access_token');
  });
});

describe('buildAwsWsProxyTarget', () => {
  it('assembles url + bearer token + start message', () => {
    expect(
      buildAwsWsProxyTarget({
        serverUrl: 'https://x.com',
        accessToken: 'tok',
        startMessage,
      }),
    ).toEqual({
      url: 'wss://x.com/api/aws-ssh-tunnel/ws',
      authToken: 'tok',
      startMessage,
    });
  });
});

describe('buildAwsServerProxyStartMessage', () => {
  it('resolves the credential env and folds it into the start message', async () => {
    const awsService = {
      buildServerProxySessionEnvSpec: vi.fn(async (_profile: string, region: string) => ({
        env: { AWS_ACCESS_KEY_ID: 'k', AWS_REGION: region },
        unsetEnv: ['AWS_PROFILE'],
      })),
    };

    const message = await buildAwsServerProxyStartMessage(awsService, {
      region: 'ap-northeast-2',
      profileName: 'prod',
      instanceId: 'i-1',
      availabilityZone: 'ap-northeast-2a',
      sshUsername: 'ec2-user',
      sshPort: 22,
      publicKey: 'ssh-ed25519 AAAA',
    });

    expect(awsService.buildServerProxySessionEnvSpec).toHaveBeenCalledWith(
      'prod',
      'ap-northeast-2',
    );
    expect(message).toEqual({
      region: 'ap-northeast-2',
      profileName: 'prod',
      instanceId: 'i-1',
      availabilityZone: 'ap-northeast-2a',
      sshUsername: 'ec2-user',
      sshPort: 22,
      publicKey: 'ssh-ed25519 AAAA',
      env: { AWS_ACCESS_KEY_ID: 'k', AWS_REGION: 'ap-northeast-2' },
      unsetEnv: ['AWS_PROFILE'],
    });
  });
});

describe('runWithAwsServerProxyAuthRetry', () => {
  function fakeAuthService(tokens: string[], refreshStatus: string | null) {
    let index = 0;
    return {
      getServerUrl: () => 'https://x.com',
      getAccessToken: () => tokens[Math.min(index, tokens.length - 1)],
      refreshSession: vi.fn(async () => {
        index += 1;
        return refreshStatus === null ? null : { status: refreshStatus };
      }),
    };
  }

  it('returns the first attempt without refreshing on success', async () => {
    const svc = fakeAuthService(['tok-1'], 'authenticated');
    const connect = vi.fn(async (token: string) => `ok:${token}`);

    await expect(runWithAwsServerProxyAuthRetry(svc, connect)).resolves.toBe('ok:tok-1');
    expect(connect).toHaveBeenCalledTimes(1);
    expect(svc.refreshSession).not.toHaveBeenCalled();
  });

  it('refreshes the token and retries once when the first attempt fails', async () => {
    const svc = fakeAuthService(['stale', 'fresh'], 'authenticated');
    const connect = vi.fn(async (token: string) => {
      if (token === 'stale') {
        throw new Error('401 Unauthorized');
      }
      return `ok:${token}`;
    });

    await expect(runWithAwsServerProxyAuthRetry(svc, connect)).resolves.toBe('ok:fresh');
    expect(connect).toHaveBeenCalledTimes(2);
    expect(svc.refreshSession).toHaveBeenCalledTimes(1);
  });

  it('rethrows the original error when the refresh does not re-authenticate', async () => {
    const svc = fakeAuthService(['stale'], null);
    const connect = vi.fn(async () => {
      throw new Error('boom');
    });

    await expect(runWithAwsServerProxyAuthRetry(svc, connect)).rejects.toThrow('boom');
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
