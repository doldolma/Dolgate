import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { usePortForwardingPanelController } from './usePortForwardingPanelController';

const mocks = vi.hoisted(() => ({
  inspectHostContainer: vi.fn(),
  listEcsTaskTunnelServices: vi.fn(),
  listHostContainers: vi.fn(),
  loadEcsTaskTunnelService: vi.fn(),
  onContainersConnectionProgress: vi.fn(() => () => undefined),
  probeKnownHost: vi.fn(),
  releaseContainerHost: vi.fn(),
  replaceKnownHost: vi.fn(),
  trustKnownHost: vi.fn(),
}));

vi.mock('../services/desktop/aws-ecs', () => ({
  listEcsTaskTunnelServices: mocks.listEcsTaskTunnelServices,
  loadEcsTaskTunnelService: mocks.loadEcsTaskTunnelService,
}));

vi.mock('../services/desktop/containers', () => ({
  inspectHostContainer: mocks.inspectHostContainer,
  listHostContainers: mocks.listHostContainers,
  onContainersConnectionProgress: mocks.onContainersConnectionProgress,
  releaseContainerHost: mocks.releaseContainerHost,
}));

vi.mock('../services/desktop/known-hosts', () => ({
  probeKnownHost: mocks.probeKnownHost,
  replaceKnownHost: mocks.replaceKnownHost,
  trustKnownHost: mocks.trustKnownHost,
}));

describe('usePortForwardingPanelController', () => {
  it('exposes discovery and known-host helpers through one controller', async () => {
    let controller: ReturnType<typeof usePortForwardingPanelController> | null = null;

    function Harness() {
      controller = usePortForwardingPanelController();
      return null;
    }

    render(<Harness />);

    await act(async () => {
      await controller!.releaseContainerHost('host-1');
      await controller!.listEcsTaskTunnelServices('host-1');
      await controller!.loadEcsTaskTunnelService('host-1', 'service-1');
      await controller!.probeKnownHost({ hostId: 'host-1' } as never);
      await controller!.listHostContainers('host-1');
      await controller!.inspectHostContainer('host-1', 'container-1');
      await controller!.replaceKnownHost({ hostId: 'host-1' } as never);
      await controller!.trustKnownHost({ hostId: 'host-1' } as never);
      controller!.onContainersConnectionProgress(vi.fn());
    });

    expect(mocks.releaseContainerHost).toHaveBeenCalledWith('host-1');
    expect(mocks.listEcsTaskTunnelServices).toHaveBeenCalledWith('host-1');
    expect(mocks.loadEcsTaskTunnelService).toHaveBeenCalledWith('host-1', 'service-1');
    expect(mocks.probeKnownHost).toHaveBeenCalledWith({ hostId: 'host-1' });
    expect(mocks.listHostContainers).toHaveBeenCalledWith('host-1');
    expect(mocks.inspectHostContainer).toHaveBeenCalledWith('host-1', 'container-1');
    expect(mocks.replaceKnownHost).toHaveBeenCalledWith({ hostId: 'host-1' });
    expect(mocks.trustKnownHost).toHaveBeenCalledWith({ hostId: 'host-1' });
    expect(mocks.onContainersConnectionProgress).toHaveBeenCalledTimes(1);
  });
});
