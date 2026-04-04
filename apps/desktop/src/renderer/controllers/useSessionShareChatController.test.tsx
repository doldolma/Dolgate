import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useSessionShareChatController } from './useSessionShareChatController';

const mocks = vi.hoisted(() => ({
  closeWindow: vi.fn(),
  getDesktopSettings: vi.fn(),
  getOwnerChatSnapshot: vi.fn(),
  onSessionShareChatEvent: vi.fn(() => () => undefined),
  onSessionShareEvent: vi.fn(() => () => undefined),
  sendOwnerChatMessage: vi.fn(),
}));

vi.mock('../services/desktop/auth-window-updater', () => ({
  closeWindow: mocks.closeWindow,
}));

vi.mock('../services/desktop/settings', () => ({
  getDesktopSettings: mocks.getDesktopSettings,
}));

vi.mock('../services/desktop/session-shares', () => ({
  getOwnerChatSnapshot: mocks.getOwnerChatSnapshot,
  onSessionShareChatEvent: mocks.onSessionShareChatEvent,
  onSessionShareEvent: mocks.onSessionShareEvent,
  sendOwnerChatMessage: mocks.sendOwnerChatMessage,
}));

describe('useSessionShareChatController', () => {
  it('exposes session share chat service operations', async () => {
    let controller: ReturnType<typeof useSessionShareChatController> | null = null;

    function Harness() {
      controller = useSessionShareChatController();
      return null;
    }

    render(<Harness />);

    await act(async () => {
      await controller!.getDesktopSettings();
      await controller!.getOwnerChatSnapshot('session-1');
      controller!.onSessionShareChatEvent(vi.fn());
      controller!.onSessionShareEvent(vi.fn());
      await controller!.sendOwnerChatMessage('session-1', 'hello');
      await controller!.closeWindow();
    });

    expect(mocks.getDesktopSettings).toHaveBeenCalledTimes(1);
    expect(mocks.getOwnerChatSnapshot).toHaveBeenCalledWith('session-1');
    expect(mocks.onSessionShareChatEvent).toHaveBeenCalledTimes(1);
    expect(mocks.onSessionShareEvent).toHaveBeenCalledTimes(1);
    expect(mocks.sendOwnerChatMessage).toHaveBeenCalledWith('session-1', 'hello');
    expect(mocks.closeWindow).toHaveBeenCalledTimes(1);
  });
});
