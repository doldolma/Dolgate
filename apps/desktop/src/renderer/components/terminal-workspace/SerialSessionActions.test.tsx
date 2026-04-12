import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { HostRecord } from '@shared';
import { SerialSessionActions } from './SerialSessionActions';
import { sendSerialControl } from '../../services/desktop/serial';

vi.mock('../../services/desktop/serial', () => ({
  sendSerialControl: vi.fn(),
}));

const serialHost: HostRecord = {
  id: 'serial-1',
  kind: 'serial',
  label: 'Console',
  transport: 'local',
  devicePath: '/dev/tty.usbserial-0001',
  host: null,
  port: null,
  baudRate: 115200,
  dataBits: 8,
  parity: 'none',
  stopBits: 1,
  flowControl: 'none',
  transmitLineEnding: 'none',
  localEcho: false,
  localLineEditing: false,
  groupName: null,
  tags: [],
  terminalThemeId: null,
  createdAt: '2026-04-12T00:00:00.000Z',
  updatedAt: '2026-04-12T00:00:00.000Z',
};

describe('SerialSessionActions', () => {
  beforeEach(() => {
    vi.mocked(sendSerialControl).mockReset();
  });

  it('shows serial control actions for supported serial sessions', async () => {
    render(
      <SerialSessionActions
        sessionId="session-1"
        host={serialHost}
        connected
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Serial session actions' }));

    expect(await screen.findByRole('menu', { name: 'Serial session actions menu' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Send Break' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Assert DTR' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Clear RTS' })).toBeInTheDocument();
  });

  it('hides control actions for raw TCP serial sessions', () => {
    render(
      <SerialSessionActions
        sessionId="session-1"
        host={{ ...serialHost, transport: 'raw-tcp', host: 'serial-gateway.local', port: 4001 }}
        connected
      />,
    );

    expect(screen.queryByRole('button', { name: 'Serial session actions' })).not.toBeInTheDocument();
  });

  it('sends serial control payloads to the desktop bridge', async () => {
    vi.mocked(sendSerialControl).mockResolvedValue(undefined);

    render(
      <SerialSessionActions
        sessionId="session-1"
        host={serialHost}
        connected
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Serial session actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Assert DTR' }));

    await waitFor(() =>
      expect(sendSerialControl).toHaveBeenCalledWith({
        sessionId: 'session-1',
        action: 'set-dtr',
        enabled: true,
      }),
    );
  });

  it('reports action failures through the transient notice callback', async () => {
    vi.mocked(sendSerialControl).mockRejectedValue(new Error('permission denied'));
    const onNotice = vi.fn();

    render(
      <SerialSessionActions
        sessionId="session-1"
        host={serialHost}
        connected
        onNotice={onNotice}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Serial session actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Send Break' }));

    await waitFor(() => expect(onNotice).toHaveBeenLastCalledWith('permission denied'));
  });
});
