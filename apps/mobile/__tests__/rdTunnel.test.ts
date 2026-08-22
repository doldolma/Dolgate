import { NativeModules } from 'react-native';
import {
  openRemoteDesktopTunnel,
  closeRemoteDesktopTunnel,
} from '../src/engine/rdTunnel';

// Mock the native module
const mockOpenTunnel = jest.fn();
const mockCloseTunnel = jest.fn();
const AUTH_TOKEN = 'ab'.repeat(32);

NativeModules.GoSshEngineModule = {
  openRemoteDesktopTunnel: mockOpenTunnel,
  closeRemoteDesktopTunnel: mockCloseTunnel,
  addListener: jest.fn(),
  removeListeners: jest.fn(),
};

beforeEach(() => {
  mockOpenTunnel.mockReset();
  mockCloseTunnel.mockReset();
});

describe('openRemoteDesktopTunnel', () => {
  it('direct transport returns original host:port', async () => {
    mockOpenTunnel.mockResolvedValue(
      JSON.stringify({
        tunnelId: 'rd-1',
        host: '192.168.1.10',
        port: 5900,
        transport: 'direct',
      }),
    );

    const result = await openRemoteDesktopTunnel({
      tunnelId: 'rd-1',
      host: '192.168.1.10',
      port: 5900,
      transport: 'direct',
    });

    expect(result.tunnelId).toBe('rd-1');
    expect(result.host).toBe('192.168.1.10');
    expect(result.port).toBe(5900);
    expect(result.transport).toBe('direct');

    // Verify the payload sent to native
    const call = mockOpenTunnel.mock.calls[0][0];
    const payload = JSON.parse(call);
    expect(payload.id).toBe('rd-1');
    expect(payload.transport).toBe('direct');
  });

  it('tailscale transport passes tailnetId', async () => {
    mockOpenTunnel.mockResolvedValue(
      JSON.stringify({
        tunnelId: 'rd-ts-1',
        host: '127.0.0.1',
        port: 49152,
        transport: 'tailscale',
        authToken: AUTH_TOKEN,
      }),
    );

    const result = await openRemoteDesktopTunnel({
      tunnelId: 'rd-ts-1',
      host: 'my-server',
      port: 5900,
      transport: 'tailscale',
      tailscale: { tailnetId: 'tn-abc', tailnetName: 'my-tailnet' },
    });

    expect(result.host).toBe('127.0.0.1');
    expect(result.port).toBe(49152);
    expect(result.transport).toBe('tailscale');
    expect(result.authToken).toBe(AUTH_TOKEN);

    const payload = JSON.parse(mockOpenTunnel.mock.calls[0][0]);
    expect(payload.tailnetId).toBe('tn-abc');
    expect(payload.tailnetName).toBe('my-tailnet');
  });

  it('ssh transport passes credentials and target', async () => {
    mockOpenTunnel.mockResolvedValue(
      JSON.stringify({
        tunnelId: 'rd-ssh-1',
        host: '127.0.0.1',
        port: 55000,
        transport: 'ssh',
        authToken: AUTH_TOKEN,
      }),
    );

    const result = await openRemoteDesktopTunnel({
      tunnelId: 'rd-ssh-1',
      host: '10.0.0.5',
      port: 5900,
      transport: 'ssh',
      ssh: {
        host: 'bastion.example.com',
        port: 22,
        username: 'admin',
        credential: { type: 'key', privateKey: 'PEM...' },
        targetHost: 'localhost',
        targetPort: 5900,
      },
    });

    expect(result.host).toBe('127.0.0.1');
    expect(result.transport).toBe('ssh');

    const payload = JSON.parse(mockOpenTunnel.mock.calls[0][0]);
    expect(payload.transport).toBe('ssh');
    expect(payload.host).toBe('bastion.example.com');
    expect(payload.port).toBe(22);
    expect(payload.username).toBe('admin');
    expect(payload.authType).toBe('privateKey');
    expect(payload.targetHost).toBe('localhost');
    expect(payload.targetPort).toBe(5900);
  });

  it('preserves the SSH target-forward error from native', async () => {
    const actualError =
      'rdtunnel: connect target: rdtunnel/ssh: forward to 127.0.0.1:5901: connection refused';
    mockOpenTunnel.mockRejectedValueOnce(new Error(actualError));

    await expect(
      openRemoteDesktopTunnel({
        tunnelId: 'rd-ssh-failed',
        host: '127.0.0.1',
        port: 5901,
        transport: 'ssh',
        ssh: {
          host: 'gateway.internal',
          port: 22,
          username: 'deploy',
          credential: { type: 'password', password: 'secret' },
          targetHost: '127.0.0.1',
          targetPort: 5901,
        },
      }),
    ).rejects.toThrow(actualError);
  });

  it('ssm transport wraps the existing local forward with authentication', async () => {
    mockOpenTunnel.mockResolvedValue(
      JSON.stringify({
        tunnelId: 'rd-ssm-1',
        host: '127.0.0.1',
        port: 55444,
        transport: 'ssm',
        authToken: AUTH_TOKEN,
      }),
    );

    const result = await openRemoteDesktopTunnel({
      tunnelId: 'rd-ssm-1',
      host: 'i-1234567890',
      port: 3389,
      transport: 'ssm',
      ssm: { localPort: 54321 },
    });

    expect(result.host).toBe('127.0.0.1');
    expect(result.port).toBe(55444);
    expect(result.transport).toBe('ssm');
    expect(result.authToken).toBe(AUTH_TOKEN);
    const payload = JSON.parse(mockOpenTunnel.mock.calls[0][0]);
    expect(payload.localPort).toBe(54321);
  });

  it('closes a native loopback tunnel that omits its authentication token', async () => {
    mockOpenTunnel.mockResolvedValue(
      JSON.stringify({
        tunnelId: 'rd-invalid-auth',
        host: '127.0.0.1',
        port: 49152,
        transport: 'tailscale',
      }),
    );
    mockCloseTunnel.mockResolvedValue(undefined);

    await expect(
      openRemoteDesktopTunnel({
        tunnelId: 'rd-invalid-auth',
        host: 'server',
        port: 5900,
        transport: 'tailscale',
        tailscale: { tailnetId: 'corp' },
      }),
    ).rejects.toThrow('authentication token');
    expect(mockCloseTunnel).toHaveBeenCalledWith('rd-invalid-auth');
  });

  it('throws when tailscale options missing', async () => {
    await expect(
      openRemoteDesktopTunnel({
        tunnelId: 'rd-fail',
        host: 'x',
        port: 5900,
        transport: 'tailscale',
      }),
    ).rejects.toThrow('tailscale options required');
  });

  it('throws when ssh options missing', async () => {
    await expect(
      openRemoteDesktopTunnel({
        tunnelId: 'rd-fail',
        host: 'x',
        port: 5900,
        transport: 'ssh',
      }),
    ).rejects.toThrow('ssh options required');
  });
});

describe('closeRemoteDesktopTunnel', () => {
  it('calls native close', async () => {
    mockCloseTunnel.mockResolvedValue(undefined);
    await closeRemoteDesktopTunnel('rd-1');
    expect(mockCloseTunnel).toHaveBeenCalledWith('rd-1');
  });

  it('skips when tunnelId is null', async () => {
    await closeRemoteDesktopTunnel(null);
    expect(mockCloseTunnel).not.toHaveBeenCalled();
  });
});
