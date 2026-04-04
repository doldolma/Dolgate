import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalTab } from '@shared';
import type { WorkspaceTab } from '../store/createAppStore';
import { useTerminalWorkspaceController } from './useTerminalWorkspaceController';

const mocks = vi.hoisted(() => ({
  dismissSessionShareChatNotification: vi.fn(),
  markSessionOutput: vi.fn(),
  resizeTerminal: vi.fn(),
  respondInteractiveAuth: vi.fn(),
  reopenInteractiveAuthUrl: vi.fn(),
  clearPendingInteractiveAuth: vi.fn(),
  sessionShareChatNotifications: {
    'session-1': [{ id: 'chat-1', nickname: 'pair', text: 'hi', sentAt: '2025-01-01T00:00:00.000Z' }],
  },
  subscribeToTerminalData: vi.fn(),
  updatePendingConnectionSize: vi.fn(),
  writeTerminalBinaryInput: vi.fn(),
  writeTerminalInput: vi.fn(),
}));

vi.mock('../store/appStore', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      pendingInteractiveAuth: null,
      respondInteractiveAuth: mocks.respondInteractiveAuth,
      reopenInteractiveAuthUrl: mocks.reopenInteractiveAuthUrl,
      clearPendingInteractiveAuth: mocks.clearPendingInteractiveAuth,
      updatePendingConnectionSize: mocks.updatePendingConnectionSize,
      markSessionOutput: mocks.markSessionOutput,
      sessionShareChatNotifications: mocks.sessionShareChatNotifications,
      dismissSessionShareChatNotification: mocks.dismissSessionShareChatNotification,
    }),
}));

vi.mock('../services/desktop/terminal', () => ({
  subscribeToTerminalData: mocks.subscribeToTerminalData,
  resizeTerminal: mocks.resizeTerminal,
  writeTerminalInput: mocks.writeTerminalInput,
  writeTerminalBinaryInput: mocks.writeTerminalBinaryInput,
}));

const tabs: TerminalTab[] = [
  {
    id: 'tab-1',
    sessionId: 'session-1',
    source: 'host',
    hostId: 'host-1',
    title: 'Host 1',
    status: 'connected',
    sessionShare: null,
    hasReceivedOutput: true,
    lastEventAt: '2025-01-01T00:00:00.000Z',
  },
  {
    id: 'tab-2',
    sessionId: 'session-2',
    source: 'host',
    hostId: 'host-2',
    title: 'Host 2',
    status: 'connected',
    sessionShare: null,
    hasReceivedOutput: true,
    lastEventAt: '2025-01-01T00:00:00.000Z',
  },
];

const activeWorkspace: WorkspaceTab = {
  id: 'workspace-1',
  title: 'Workspace',
  layout: {
    id: 'split-1',
    kind: 'split',
    axis: 'horizontal',
    ratio: 0.5,
    first: { id: 'leaf-1', kind: 'leaf', sessionId: 'session-1' },
    second: { id: 'leaf-2', kind: 'leaf', sessionId: 'session-2' },
  },
  activeSessionId: 'session-1',
  broadcastEnabled: true,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useTerminalWorkspaceController', () => {
  it('routes session transport through the terminal service layer and fan-outs broadcast input', async () => {
    let controller: ReturnType<typeof useTerminalWorkspaceController> | null = null;

    function Harness() {
      controller = useTerminalWorkspaceController({
        activeWorkspace,
        tabs,
      });
      return null;
    }

    render(<Harness />);

    await act(async () => {
      await controller!.onResizeSession('session-1', 120, 32);
      await controller!.sendSessionInput('session-1', 'ls\n');
      await controller!.sendSessionBinaryInput(
        'session-1',
        new Uint8Array([1, 2, 3]),
      );
    });

    expect(mocks.resizeTerminal).toHaveBeenCalledWith('session-1', 120, 32);
    expect(mocks.writeTerminalInput).toHaveBeenCalledTimes(2);
    expect(mocks.writeTerminalInput).toHaveBeenNthCalledWith(1, 'session-1', 'ls\n');
    expect(mocks.writeTerminalInput).toHaveBeenNthCalledWith(2, 'session-2', 'ls\n');
    expect(mocks.writeTerminalBinaryInput).toHaveBeenCalledTimes(2);
  });

  it('does not await terminal writes on the input hot path', () => {
    let controller: ReturnType<typeof useTerminalWorkspaceController> | null = null;
    const never = new Promise<void>(() => undefined);
    mocks.writeTerminalInput.mockReturnValue(never);
    mocks.writeTerminalBinaryInput.mockReturnValue(never);

    function Harness() {
      controller = useTerminalWorkspaceController({
        activeWorkspace,
        tabs,
      });
      return null;
    }

    render(<Harness />);

    expect(controller!.sendSessionInput('session-1', 'pwd\n')).toBeUndefined();
    expect(
      controller!.sendSessionBinaryInput('session-1', new Uint8Array([1])),
    ).toBeUndefined();
    expect(mocks.writeTerminalInput).toHaveBeenCalledTimes(2);
    expect(mocks.writeTerminalBinaryInput).toHaveBeenCalledTimes(2);
  });

  it('updates pending connection size locally and exposes chat notifications without transport calls', async () => {
    let controller: ReturnType<typeof useTerminalWorkspaceController> | null = null;

    function Harness() {
      controller = useTerminalWorkspaceController({
        activeWorkspace: null,
        tabs,
      });
      return null;
    }

    render(<Harness />);

    await act(async () => {
      await controller!.onResizeSession('pending:session-1', 100, 30);
    });

    expect(mocks.updatePendingConnectionSize).toHaveBeenCalledWith(
      'pending:session-1',
      100,
      30,
    );
    expect(controller!.getSessionShareChatNotifications('session-1')).toHaveLength(1);
  });
});
