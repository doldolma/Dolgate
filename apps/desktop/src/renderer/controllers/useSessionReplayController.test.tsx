import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useSessionReplayController } from './useSessionReplayController';

const mocks = vi.hoisted(() => ({
  getDesktopSettings: vi.fn(),
  getSessionReplay: vi.fn(),
  openSessionReplay: vi.fn(),
}));

vi.mock('../services/desktop/settings', () => ({
  getDesktopSettings: mocks.getDesktopSettings,
}));

vi.mock('../services/desktop/session-replays', () => ({
  getSessionReplay: mocks.getSessionReplay,
  openSessionReplay: mocks.openSessionReplay,
}));

describe('useSessionReplayController', () => {
  it('delegates replay loading to the desktop services layer', async () => {
    let controller: ReturnType<typeof useSessionReplayController> | null = null;

    function Harness() {
      controller = useSessionReplayController();
      return null;
    }

    render(<Harness />);

    await act(async () => {
      await controller!.getDesktopSettings();
      await controller!.getSessionReplay('recording-1');
      await controller!.openSessionReplay('recording-1');
    });

    expect(mocks.getDesktopSettings).toHaveBeenCalledTimes(1);
    expect(mocks.getSessionReplay).toHaveBeenCalledWith('recording-1');
    expect(mocks.openSessionReplay).toHaveBeenCalledWith('recording-1');
  });
});
