import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcChannels } from '../../common/ipc-channels';
import { HostsOverrideError } from '../hosts-override-manager';
import { registerPortForwardAndDnsIpcHandlers } from './port-forwards-dns';

const electronSpies = vi.hoisted(() => ({
  ipcMainHandle: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: electronSpies.ipcMainHandle,
  },
}));

describe('registerPortForwardAndDnsIpcHandlers', () => {
  beforeEach(() => {
    electronSpies.ipcMainHandle.mockReset();
  });

  it('logs and rethrows a user-facing error when static DNS activation fails', async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    electronSpies.ipcMainHandle.mockImplementation((channel, handler) => {
      handlers.set(channel, handler);
    });

    const record = {
      id: 'dns-static-1',
      type: 'static',
      hostname: 'basket',
      address: '127.0.0.1',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    } as const;

    const setStaticOverrideActive = vi.fn();
    const appendActivityLog = vi.fn();

    registerPortForwardAndDnsIpcHandlers({
      listPortForwardSnapshot: vi.fn(() => ({ rules: [], runtimes: [] })),
      listResolvedDnsOverrides: vi.fn(() => []),
      rewriteActiveDnsOverrides: vi.fn(async () => {
        throw new HostsOverrideError(
          'helper-rpc',
          'DNS Override를 적용하지 못했습니다. Dolgate DNS Helper가 요청을 처리하지 못했습니다.',
          'helper rpc failed',
        );
      }),
      dnsOverrides: {
        getById: vi.fn(() => record),
      },
      hostsOverrideManager: {
        getActiveStaticOverrideIds: vi.fn(() => new Set<string>()),
        setStaticOverrideActive,
      },
      activityLogs: {
        append: appendActivityLog,
      },
      queueSync: vi.fn(),
    } as any);

    const handler = handlers.get(ipcChannels.dnsOverrides.setStaticActive);
    expect(handler).toBeTypeOf('function');
    if (!handler) {
      throw new Error('expected static dns override handler to be registered');
    }

    await expect(handler({}, 'dns-static-1', true)).rejects.toThrow(
      'DNS Override를 적용하지 못했습니다. Dolgate DNS Helper가 요청을 처리하지 못했습니다.',
    );

    expect(setStaticOverrideActive).toHaveBeenNthCalledWith(1, 'dns-static-1', true);
    expect(setStaticOverrideActive).toHaveBeenNthCalledWith(2, 'dns-static-1', false);
    expect(appendActivityLog).toHaveBeenCalledWith(
      'error',
      'audit',
      'DNS Override를 적용하지 못했습니다. Dolgate DNS Helper가 요청을 처리하지 못했습니다.',
      expect.objectContaining({
        dnsOverrideId: 'dns-static-1',
        hostname: 'basket',
        address: '127.0.0.1',
        active: true,
        stage: 'helper-rpc',
        rawError: 'helper rpc failed',
      }),
    );
  });

  it('includes the raw helper-not-ready cause in the user-facing error', async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    electronSpies.ipcMainHandle.mockImplementation((channel, handler) => {
      handlers.set(channel, handler);
    });

    const record = {
      id: 'dns-static-1',
      type: 'static',
      hostname: 'basket',
      address: '127.0.0.1',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    } as const;

    registerPortForwardAndDnsIpcHandlers({
      listPortForwardSnapshot: vi.fn(() => ({ rules: [], runtimes: [] })),
      listResolvedDnsOverrides: vi.fn(() => []),
      rewriteActiveDnsOverrides: vi.fn(async () => {
        throw new HostsOverrideError(
          'helper-not-ready',
          'Dolgate DNS Helper가 준비되지 않았습니다. 잠시 후 다시 시도해 주세요.',
          'connect: permission denied',
        );
      }),
      dnsOverrides: {
        getById: vi.fn(() => record),
      },
      hostsOverrideManager: {
        getActiveStaticOverrideIds: vi.fn(() => new Set<string>()),
        setStaticOverrideActive: vi.fn(),
      },
      activityLogs: {
        append: vi.fn(),
      },
      queueSync: vi.fn(),
    } as any);

    const handler = handlers.get(ipcChannels.dnsOverrides.setStaticActive);
    expect(handler).toBeTypeOf('function');
    if (!handler) {
      throw new Error('expected static dns override handler to be registered');
    }

    await expect(handler({}, 'dns-static-1', true)).rejects.toThrow(
      'Dolgate DNS Helper가 준비되지 않았습니다. 잠시 후 다시 시도해 주세요. 원인: connect: permission denied',
    );
  });
});
