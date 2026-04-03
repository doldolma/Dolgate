import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/tmp/dolssh',
    isPackaged: false,
  },
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(() => true),
  };
});

import {
  DOLGATE_DNS_HELPER_BINARY_NAME,
  HostsOverrideManager,
  buildHostsHelperEndpoint,
  buildHostsHelperPayload,
  buildHostsHelperServeArgs,
  buildMacElevationScript,
  buildWindowsElevationCommand,
  collectActiveDnsOverrideEntries,
  hasManagedHostsBlock,
  resolveDnsOverrideRecords,
} from './hosts-override-manager';
import type { DnsOverrideRecord, PortForwardRuleRecord, PortForwardRuntimeRecord } from '@shared';

describe('hosts override manager helpers', () => {
  it('collects only running loopback-linked overrides', () => {
    const rules: PortForwardRuleRecord[] = [
      {
        id: 'rule-1',
        transport: 'aws-ssm',
        label: 'Broker 1',
        hostId: 'host-1',
        bindAddress: '127.0.0.2',
        bindPort: 9098,
        targetKind: 'remote-host',
        targetPort: 9098,
        remoteHost: 'b-1.kafka.internal',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
      {
        id: 'rule-2',
        transport: 'ssh',
        label: 'Dynamic',
        hostId: 'host-2',
        mode: 'dynamic',
        bindAddress: '127.0.0.1',
        bindPort: 1080,
        targetHost: null,
        targetPort: null,
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
    ];
    const overrides: DnsOverrideRecord[] = [
      {
        id: 'dns-1',
        type: 'linked',
        hostname: 'b-1.kafka.internal',
        portForwardRuleId: 'rule-1',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
      {
        id: 'dns-2',
        type: 'linked',
        hostname: 'ignored.kafka.internal',
        portForwardRuleId: 'rule-2',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
      {
        id: 'dns-3',
        type: 'static',
        hostname: 'static.kafka.internal',
        address: '10.0.0.15',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
    ];
    const runtimes: PortForwardRuntimeRecord[] = [
      {
        ruleId: 'rule-1',
        hostId: 'host-1',
        transport: 'aws-ssm',
        mode: 'local',
        bindAddress: '127.0.0.2',
        bindPort: 9098,
        status: 'running',
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
      {
        ruleId: 'rule-2',
        hostId: 'host-2',
        transport: 'ssh',
        mode: 'dynamic',
        bindAddress: '127.0.0.1',
        bindPort: 1080,
        status: 'running',
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
    ];

    expect(collectActiveDnsOverrideEntries(overrides, rules, runtimes, new Set(['dns-3']))).toEqual([
      {
        hostname: 'b-1.kafka.internal',
        address: '127.0.0.2',
        ruleId: 'rule-1',
      },
      {
        hostname: 'static.kafka.internal',
        address: '10.0.0.15',
        ruleId: 'dns-3',
      },
    ]);
  });

  it('builds the helper payload in base64 JSON', () => {
    expect(
      Buffer.from(
        buildHostsHelperPayload([
          { hostname: 'b-1.kafka.internal', address: '127.0.0.2', ruleId: 'rule-1' },
        ]),
        'base64',
      ).toString('utf8'),
    ).toBe('[{"address":"127.0.0.2","hostname":"b-1.kafka.internal"}]');
  });

  it('detects managed hosts blocks', () => {
    expect(hasManagedHostsBlock('# >>> dolssh managed dns overrides >>>\n')).toBe(true);
    expect(hasManagedHostsBlock('127.0.0.1 localhost\n')).toBe(false);
  });

  it('builds serve args for the branded helper', () => {
    expect(buildHostsHelperServeArgs('pipe', 'token', 'hosts')).toEqual([
      'serve',
      '--endpoint',
      'pipe',
      '--auth-token',
      'token',
      '--hosts-file',
      'hosts',
    ]);
  });

  it('renders the Windows elevation command for Dolgate DNS Helper', () => {
    expect(
      buildWindowsElevationCommand('C:\\dolgate-dns-helper.exe', [
        'serve',
        '--endpoint',
        '\\\\.\\pipe\\dolgate',
      ]),
    ).toContain('Start-Process');
  });

  it('renders the macOS elevation script for background helper launch', () => {
    expect(
      buildMacElevationScript('/tmp/dolgate-dns-helper', ['serve', '--endpoint', '/tmp/dolgate.sock']),
    ).toContain('nohup');
    expect(
      buildMacElevationScript('/tmp/dolgate-dns-helper', ['serve', '--endpoint', '/tmp/dolgate.sock']),
    ).toContain('with administrator privileges');
  });

  it('builds platform-specific helper endpoints', () => {
    expect(buildHostsHelperEndpoint('win32', 'id-1')).toContain('\\\\.\\pipe\\dolgate-dns-helper-');
    expect(buildHostsHelperEndpoint('darwin', 'id-2', '/tmp')).toMatch(/\/tmp\/dolgate-dns-helper-\d+-id-2\.sock$/);
  });

  it('exposes the branded helper binary name', () => {
    expect(DOLGATE_DNS_HELPER_BINARY_NAME).toMatch(/dolgate-dns-helper/);
  });

  it('marks static overrides inactive unless the current app session activated them', () => {
    const overrides: DnsOverrideRecord[] = [
      {
        id: 'dns-static-1',
        type: 'static',
        hostname: 'basket',
        address: '10.0.1.15',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
    ];

    expect(resolveDnsOverrideRecords(overrides, [], [])).toEqual([
      {
        ...overrides[0],
        status: 'inactive',
      },
    ]);
    expect(resolveDnsOverrideRecords(overrides, [], [], new Set(['dns-static-1']))).toEqual([
      {
        ...overrides[0],
        status: 'active',
      },
    ]);
  });
});

describe('HostsOverrideManager', () => {
  it('reuses the launched helper session across multiple rewrites', async () => {
    const requests: Array<{ command: string; entries?: Array<{ address: string; hostname: string }> }> = [];
    const launchHelper = vi.fn(async () => undefined);
    const closeClient = vi.fn();
    const client = {
      send: vi.fn(async (request: { command: string; entries?: Array<{ address: string; hostname: string }> }) => {
        requests.push({ command: request.command, entries: request.entries });
        return { ok: true };
      }),
      close: closeClient,
    };

    const manager = new HostsOverrideManager({
      platform: 'win32',
      helperPath: 'C:\\dolgate-dns-helper.exe',
      hostsFilePath: 'C:\\Windows\\System32\\drivers\\etc\\hosts',
      fileReader: async () => '',
      launchHelper,
      clientFactory: async () => client,
      uuidFactory: (() => {
        let sequence = 0;
        return () => `id-${++sequence}`;
      })(),
      launchPollIntervalMs: 0,
      launchTimeoutMs: 100,
    });

    await manager.rewrite([{ hostname: 'basket', address: '10.0.1.15', ruleId: 'dns-1' }]);
    await manager.rewrite([{ hostname: 'b-1.kafka.internal', address: '127.0.0.2', ruleId: 'rule-1' }]);

    expect(launchHelper).toHaveBeenCalledTimes(1);
    expect(requests.map((request) => request.command)).toEqual([
      'ping',
      'rewrite-block',
      'ping',
      'rewrite-block',
    ]);
  });

  it('relaunches the helper after the connection breaks', async () => {
    const launchHelper = vi.fn(async () => undefined);
    const firstClient = {
      send: vi
        .fn()
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: true })
        .mockRejectedValueOnce(new Error('broken pipe')),
      close: vi.fn(),
    };
    const secondClient = {
      send: vi.fn(async () => ({ ok: true })),
      close: vi.fn(),
    };
    const clientFactory = vi
      .fn()
      .mockResolvedValueOnce(firstClient)
      .mockResolvedValueOnce(secondClient);

    const manager = new HostsOverrideManager({
      platform: 'win32',
      helperPath: 'C:\\dolgate-dns-helper.exe',
      hostsFilePath: 'C:\\Windows\\System32\\drivers\\etc\\hosts',
      fileReader: async () => '# >>> dolssh managed dns overrides >>>\n',
      launchHelper,
      clientFactory,
      uuidFactory: (() => {
        let sequence = 0;
        return () => `id-${++sequence}`;
      })(),
      launchPollIntervalMs: 0,
      launchTimeoutMs: 100,
    });

    await manager.rewrite([{ hostname: 'basket', address: '10.0.1.15', ruleId: 'dns-1' }]);
    await manager.clear();

    expect(launchHelper).toHaveBeenCalledTimes(2);
    expect(firstClient.close).toHaveBeenCalledTimes(1);
  });

  it('clears and shuts down the helper on shutdown', async () => {
    const sentCommands: string[] = [];
    const launchHelper = vi.fn(async () => undefined);
    const client = {
      send: vi.fn(async (request: { command: string }) => {
        sentCommands.push(request.command);
        return { ok: true };
      }),
      close: vi.fn(),
    };

    const manager = new HostsOverrideManager({
      platform: 'win32',
      helperPath: 'C:\\dolgate-dns-helper.exe',
      hostsFilePath: 'C:\\Windows\\System32\\drivers\\etc\\hosts',
      fileReader: async () => '# >>> dolssh managed dns overrides >>>\n',
      launchHelper,
      clientFactory: async () => client,
      uuidFactory: (() => {
        let sequence = 0;
        return () => `id-${++sequence}`;
      })(),
      launchPollIntervalMs: 0,
      launchTimeoutMs: 100,
    });

    await manager.clear();
    await manager.shutdown();

    expect(sentCommands).toContain('clear-block');
    expect(sentCommands).toContain('shutdown');
    expect(client.close).toHaveBeenCalled();
  });
});
