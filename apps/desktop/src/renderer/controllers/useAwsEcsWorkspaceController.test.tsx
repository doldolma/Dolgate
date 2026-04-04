import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAwsEcsWorkspaceController } from './useAwsEcsWorkspaceController';

const mocks = vi.hoisted(() => ({
  loadEcsServiceActionContext: vi.fn(),
  loadEcsServiceLogs: vi.fn(),
  onPortForwardRuntimeEvent: vi.fn(() => () => undefined),
  startEcsServiceTunnel: vi.fn(),
  stopEcsServiceTunnel: vi.fn(),
}));

vi.mock('../services/desktop/aws-ecs', () => ({
  loadEcsServiceActionContext: mocks.loadEcsServiceActionContext,
  loadEcsServiceLogs: mocks.loadEcsServiceLogs,
  startEcsServiceTunnel: mocks.startEcsServiceTunnel,
  stopEcsServiceTunnel: mocks.stopEcsServiceTunnel,
}));

vi.mock('../services/desktop/port-forward-events', () => ({
  onPortForwardRuntimeEvent: mocks.onPortForwardRuntimeEvent,
}));

describe('useAwsEcsWorkspaceController', () => {
  it('delegates ECS workspace orchestration to desktop services', async () => {
    let controller: ReturnType<typeof useAwsEcsWorkspaceController> | null = null;

    function Harness() {
      controller = useAwsEcsWorkspaceController();
      return null;
    }

    render(<Harness />);

    await act(async () => {
      controller!.onPortForwardRuntimeEvent(vi.fn());
      await controller!.loadEcsServiceActionContext('host-1', 'service-1');
      await controller!.loadEcsServiceLogs({ hostId: 'host-1' } as never);
      await controller!.startEcsServiceTunnel({ hostId: 'host-1' } as never);
      await controller!.stopEcsServiceTunnel('runtime-1');
    });

    expect(mocks.onPortForwardRuntimeEvent).toHaveBeenCalledTimes(1);
    expect(mocks.loadEcsServiceActionContext).toHaveBeenCalledWith('host-1', 'service-1');
    expect(mocks.loadEcsServiceLogs).toHaveBeenCalledWith({ hostId: 'host-1' });
    expect(mocks.startEcsServiceTunnel).toHaveBeenCalledWith({ hostId: 'host-1' });
    expect(mocks.stopEcsServiceTunnel).toHaveBeenCalledWith('runtime-1');
  });
});
