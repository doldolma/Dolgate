import { GoSshEngineAdapter, isGoEngineAvailable } from './goEngine';
import type { MobileSshEngine } from './types';

export * from './types';
export { isGoEngineAvailable, getGoEngineVersion, resetGoEngineEvents } from './goEngine';
export {
  openRemoteDesktopTunnel,
  closeRemoteDesktopTunnel,
} from './rdTunnel';
export type {
  RDTunnelTransport,
  RDTunnelEndpoint,
  OpenRemoteDesktopTunnelOptions,
  RDTunnelSshOptions,
  RDTunnelTailscaleOptions,
  RDTunnelSsmOptions,
} from './rdTunnel';

// There is one engine now: the Go engine in services/ssh-core/mobile, bound with
// gomobile. The russh (Rust) engine it replaced is gone, and with it the
// selection machinery that let both coexist during the migration.
//
// MobileSshEngine stays as an interface even with a single implementation: it is
// what keeps the session flow from knowing about the bridge, and it is how the
// migration was carried out without touching the session flow twice.
let engine: GoSshEngineAdapter | null = null;

export function getEngine(): MobileSshEngine {
  engine = engine ?? new GoSshEngineAdapter();
  return engine;
}

/** Test seam: drops the cached engine instance. */
export function resetEngine(): void {
  engine = null;
}
