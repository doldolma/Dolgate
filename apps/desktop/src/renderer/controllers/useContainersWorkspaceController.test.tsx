import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useContainersWorkspaceController } from './useContainersWorkspaceController';

const mocks = vi.hoisted(() => ({
  startContainerTunnel: vi.fn(),
  stopContainerTunnel: vi.fn(),
}));

vi.mock('../services/desktop/containers', () => ({
  startContainerTunnel: mocks.startContainerTunnel,
  stopContainerTunnel: mocks.stopContainerTunnel,
}));

describe('useContainersWorkspaceController', () => {
  it('routes tunnel actions through the containers service layer', async () => {
    let controller: ReturnType<typeof useContainersWorkspaceController> | null = null;

    function Harness() {
      controller = useContainersWorkspaceController();
      return null;
    }

    render(<Harness />);

    await act(async () => {
      await controller!.startContainerTunnel({ hostId: 'host-1' } as never);
      await controller!.stopContainerTunnel('runtime-1');
    });

    expect(mocks.startContainerTunnel).toHaveBeenCalledWith({ hostId: 'host-1' });
    expect(mocks.stopContainerTunnel).toHaveBeenCalledWith('runtime-1');
  });
});
