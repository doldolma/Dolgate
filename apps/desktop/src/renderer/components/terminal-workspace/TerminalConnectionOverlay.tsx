import {
  ConnectionStatusOverlay,
  type ConnectionStatusOverlayProps,
} from '../ConnectionStatusOverlay';

export type TerminalConnectionOverlayProps = ConnectionStatusOverlayProps;

export function TerminalConnectionOverlay(props: TerminalConnectionOverlayProps) {
  return <ConnectionStatusOverlay {...props} />;
}
