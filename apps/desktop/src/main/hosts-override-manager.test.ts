import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';

const sudoPromptSpies = vi.hoisted(() => ({
  exec: vi.fn(),
}));

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

vi.mock('@vscode/sudo-prompt', () => ({
  exec: sudoPromptSpies.exec,
}));

import {
  DOLGATE_DNS_HELPER_BINARY_NAME,
  DOLGATE_DNS_HELPER_PROMPT_NAME,
  HostsOverrideManager,
  buildHostsHelperEndpoint,
  buildHostsHelperPayload,
  buildHostsHelperServeArgs,
  buildMacElevationCommand,
  buildWindowsElevationCommand,
  collectActiveDnsOverrideEntries,
  hasManagedHostsBlock,
  resolveDnsOverrideRecords,
} from './hosts-override-manager';
import type { DnsOverrideRecord, PortForwardRuleRecord, PortForwardRuntimeRecord } from '@shared';

function buildManagedHostsBlock(
  entries: Array<{ address: string; hostname: string }>,
): string {
  if (entries.length === 0) {
    return '';
  }
  return [
    '# >>> dolssh managed dns overrides >>>',
    ...entries
      .map((entry) => `${entry.address} ${entry.hostname.toLowerCase()}`)
      .sort((left, right) => left.localeCompare(right)),
    '# <<< dolssh managed dns overrides <<<',
    '',
  ].join('\n');
}

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

  it('renders the macOS elevation command for helper launch', () => {
    expect(
      buildMacElevationCommand('/tmp/dolgate-dns-helper', ['serve', '--endpoint', '/tmp/dolgate.sock']),
    ).toContain("'/tmp/dolgate-dns-helper' 'serve' '--endpoint' '/tmp/dolgate.sock'");
    expect(
      buildMacElevationCommand('/tmp/dolgate-dns-helper', ['serve', '--endpoint', '/tmp/dolgate.sock']),
    ).not.toContain('with administrator privileges');
    expect(
      buildMacElevationCommand('/tmp/dolgate-dns-helper', ['serve', '--endpoint', '/tmp/dolgate.sock']),
    ).not.toContain('nohup');
    expect(
      buildMacElevationCommand(
        '/tmp/dolgate-dns-helper',
        ['serve', '--endpoint', '/tmp/dolgate.sock'],
        '/tmp/dolgate-dns-helper.log',
      ),
    ).toContain(">'/tmp/dolgate-dns-helper.log' 2>&1 </dev/null");
  });

  it('builds platform-specific helper endpoints', () => {
    expect(buildHostsHelperEndpoint('win32', 'id-1')).toContain('\\\\.\\pipe\\dolgate-dns-helper-');
    const shortEndpoint = buildHostsHelperEndpoint('darwin', 'id-2', '/tmp');
    expect(shortEndpoint).toMatch(/\/tmp\/dgdns-\d+-id2\.sock$/);
    expect(shortEndpoint.length).toBeLessThanOrEqual(103);

    const fallbackEndpoint = buildHostsHelperEndpoint(
      'darwin',
      '123e4567-e89b-12d3-a456-426614174000',
      '/this/path/is/intentionally/long/enough/to/exceed/the/macos/unix/socket/path/length/limit',
    );
    expect(fallbackEndpoint).toMatch(/\/tmp\/dgdns-\d+-6614174000\.sock$/);
    expect(fallbackEndpoint.length).toBeLessThanOrEqual(103);
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
  beforeEach(() => {
    sudoPromptSpies.exec.mockReset();
    sudoPromptSpies.exec.mockImplementation((_command, options, callback) => {
      const done = typeof options === 'function' ? options : callback;
      done?.(undefined, '', '');
    });
  });

  it('does not resolve the helper binary path during construction', () => {
    const existsSyncMock = vi.mocked(existsSync);
    existsSyncMock.mockReturnValue(false);
    try {
      expect(() => new HostsOverrideManager({ platform: 'darwin' })).not.toThrow();
    } finally {
      existsSyncMock.mockReturnValue(true);
    }
  });

  it('resolves the helper binary path lazily when launching the helper', async () => {
    const existsSyncMock = vi.mocked(existsSync);
    existsSyncMock.mockReturnValue(false);
    try {
      const manager = new HostsOverrideManager({
        platform: 'darwin',
        hostsFilePath: '/etc/hosts',
        fileReader: async () => '',
        launchPollIntervalMs: 0,
        launchTimeoutMs: 100,
      });

      expect(existsSyncMock).not.toHaveBeenCalled();
      await expect(manager.ensureReady()).rejects.toThrow();
      expect(existsSyncMock).toHaveBeenCalled();
    } finally {
      existsSyncMock.mockReturnValue(true);
    }
  });

  it('reuses the launched helper session across multiple rewrites', async () => {
    const requests: Array<{ command: string; entries?: Array<{ address: string; hostname: string }> }> = [];
    const launchHelper = vi.fn(async () => undefined);
    const closeClient = vi.fn();
    let hostsFileContent = '';
    const client = {
      send: vi.fn(async (request: { command: string; entries?: Array<{ address: string; hostname: string }> }) => {
        requests.push({ command: request.command, entries: request.entries });
        if (request.command === 'rewrite-block') {
          hostsFileContent = buildManagedHostsBlock(request.entries ?? []);
        }
        return { ok: true };
      }),
      close: closeClient,
    };

    const manager = new HostsOverrideManager({
      platform: 'win32',
      helperPath: 'C:\\dolgate-dns-helper.exe',
      hostsFilePath: 'C:\\Windows\\System32\\drivers\\etc\\hosts',
      fileReader: async () => hostsFileContent,
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
    let hostsFileContent = '';
    const firstClient = {
      send: vi.fn(async (request: { command: string; entries?: Array<{ address: string; hostname: string }> }) => {
        if (request.command === 'ping') {
          if (firstClient.send.mock.calls.length >= 3) {
            throw new Error('broken pipe');
          }
          return { ok: true };
        }
        if (request.command === 'rewrite-block') {
          hostsFileContent = buildManagedHostsBlock(request.entries ?? []);
          return { ok: true };
        }
        throw new Error('broken pipe');
      }),
      close: vi.fn(),
    };
    const secondClient = {
      send: vi.fn(async (request: { command: string }) => {
        if (request.command === 'clear-block') {
          hostsFileContent = '';
        }
        return { ok: true };
      }),
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
      fileReader: async () => hostsFileContent,
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
    let hostsFileContent = buildManagedHostsBlock([
      { hostname: 'basket', address: '10.0.1.15' },
    ]);
    const client = {
      send: vi.fn(async (request: { command: string }) => {
        sentCommands.push(request.command);
        if (request.command === 'clear-block') {
          hostsFileContent = '';
        }
        return { ok: true };
      }),
      close: vi.fn(),
    };

    const manager = new HostsOverrideManager({
      platform: 'win32',
      helperPath: 'C:\\dolgate-dns-helper.exe',
      hostsFilePath: 'C:\\Windows\\System32\\drivers\\etc\\hosts',
      fileReader: async () => hostsFileContent,
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

  it('uses sudo-prompt with the branded helper name on macOS', async () => {
    let hostsFileContent = '';
    const client = {
      send: vi.fn(async (request: { command: string; entries?: Array<{ address: string; hostname: string }> }) => {
        if (request.command === 'rewrite-block') {
          hostsFileContent = buildManagedHostsBlock(request.entries ?? []);
        }
        return { ok: true };
      }),
      close: vi.fn(),
    };

    const manager = new HostsOverrideManager({
      platform: 'darwin',
      helperPath: '/tmp/dolgate-dns-helper',
      hostsFilePath: '/etc/hosts',
      fileReader: async () => hostsFileContent,
      clientFactory: async () => client,
      uuidFactory: (() => {
        let sequence = 0;
        return () => `id-${++sequence}`;
      })(),
      launchPollIntervalMs: 0,
      launchTimeoutMs: 100,
    });

    await manager.rewrite([
      { hostname: 'basket', address: '10.0.1.15', ruleId: 'dns-1' },
    ]);

    expect(sudoPromptSpies.exec).toHaveBeenCalledTimes(1);
    expect(sudoPromptSpies.exec.mock.calls[0]?.[0]).toContain('/tmp/dolgate-dns-helper');
    expect(sudoPromptSpies.exec.mock.calls[0]?.[0]).not.toContain('nohup');
    expect(sudoPromptSpies.exec.mock.calls[0]?.[0]).toContain('</dev/null');
    expect(sudoPromptSpies.exec.mock.calls[0]?.[1]).toMatchObject({
      name: DOLGATE_DNS_HELPER_PROMPT_NAME,
    });
  });

  it('surfaces a permission-denied error when the macOS prompt is cancelled', async () => {
    sudoPromptSpies.exec.mockImplementationOnce((_command, options, callback) => {
      const done = typeof options === 'function' ? options : callback;
      done?.(new Error('User did not grant permission.'));
    });

    const manager = new HostsOverrideManager({
      platform: 'darwin',
      helperPath: '/tmp/dolgate-dns-helper',
      hostsFilePath: '/etc/hosts',
      fileReader: async () => '',
      launchPollIntervalMs: 0,
      launchTimeoutMs: 100,
    });

    await expect(manager.ensureReady()).rejects.toMatchObject({
      stage: 'permission-denied',
      message: 'DNS Override 권한 승인이 취소되었습니다.',
    });
  });

  it('surfaces a helper-not-ready error when the helper never becomes reachable', async () => {
    const manager = new HostsOverrideManager({
      platform: 'darwin',
      helperPath: '/tmp/dolgate-dns-helper',
      hostsFilePath: '/etc/hosts',
      fileReader: async () => '',
      clientFactory: async () => {
        throw new Error('connect ECONNREFUSED');
      },
      launchPollIntervalMs: 0,
      launchTimeoutMs: 5,
    });

    await expect(manager.ensureReady()).rejects.toMatchObject({
      stage: 'helper-not-ready',
      message: 'Dolgate DNS Helper가 준비되지 않았습니다. 잠시 후 다시 시도해 주세요.',
      rawError: 'connect ECONNREFUSED',
    });
  });

  it('surfaces a hosts-verification error when rewrite does not update the hosts file', async () => {
    const launchHelper = vi.fn(async () => undefined);
    const client = {
      send: vi.fn(async () => ({ ok: true })),
      close: vi.fn(),
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

    await expect(
      manager.rewrite([
        { hostname: 'basket', address: '10.0.1.15', ruleId: 'dns-1' },
      ]),
    ).rejects.toMatchObject({
      stage: 'hosts-verification',
      message: 'DNS Override를 적용했지만 hosts 파일에서 확인되지 않았습니다.',
    });
  });

  it('verifies rewritten hosts content through the helper when direct hosts reads are permission denied', async () => {
    const launchHelper = vi.fn(async () => undefined);
    const expectedHosts = buildManagedHostsBlock([
      { hostname: 'basket', address: '10.0.1.15' },
    ]);
    const client = {
      send: vi.fn(async (request: { command: string; entries?: Array<{ address: string; hostname: string }> }) => {
        if (request.command === 'read-hosts') {
          return { ok: true, hostsFileContent: expectedHosts };
        }
        return { ok: true };
      }),
      close: vi.fn(),
    };

    const manager = new HostsOverrideManager({
      platform: 'darwin',
      helperPath: '/tmp/dolgate-dns-helper',
      hostsFilePath: '/etc/hosts',
      fileReader: async () => {
        throw new Error("EACCES: permission denied, open '/etc/hosts'");
      },
      launchHelper,
      clientFactory: async () => client,
      uuidFactory: (() => {
        let sequence = 0;
        return () => `id-${++sequence}`;
      })(),
      launchPollIntervalMs: 0,
      launchTimeoutMs: 100,
    });

    await expect(
      manager.rewrite([
        { hostname: 'basket', address: '10.0.1.15', ruleId: 'dns-1' },
      ]),
    ).resolves.toBeUndefined();

    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'read-hosts',
        hostsFilePath: '/etc/hosts',
      }),
    );
  });
});
