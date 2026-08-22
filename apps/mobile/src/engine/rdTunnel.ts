/**
 * Remote Desktop loopback tunnel API.
 *
 * Provides a typed surface for the JS layer to open/close tunnels through the
 * Go mobile engine. The Rust VNC/RDP core dials the returned host:port.
 *
 * Route matrix:
 *   direct    → no listener, original host:port returned as-is
 *   tailscale → Go opens 127.0.0.1 ephemeral, bridges to tailnet dial
 *   ssh       → Go opens 127.0.0.1 ephemeral, bridges via SSH port forward
 *   ssm       → uses existing startSsmPortForward, returns its local port as direct
 */
import { NativeModules } from 'react-native';
import { runWithGoConnectionEvents } from './goEngine';
import type {
  ConnectOptions,
  EngineCredential,
  EngineJumpTarget,
  EngineTailnetRoute,
} from './types';

// ---------- Public types ----------

export type RDTunnelTransport = 'direct' | 'tailscale' | 'ssh' | 'ssm';

/**
 * Options for SSH tunnel transport. The SSH connection is opened specifically
 * to forward TCP to the VNC/RDP endpoint visible from the SSH server.
 */
export interface RDTunnelSshOptions {
  /** SSH server host (or tailnet node name if tailnet is set). */
  host: string;
  /** SSH server port. */
  port: number;
  username: string;
  credential: EngineCredential;
  /** VNC/RDP host as seen from the SSH server. Defaults to "localhost". */
  targetHost?: string;
  /** VNC/RDP port on the target. Defaults to the top-level `port` in the request. */
  targetPort?: number;
  /** Route the SSH connection itself through a Tailnet. */
  tailnet?: EngineTailnetRoute;
  /** Previously trusted host keys for the SSH tunnel endpoint. */
  trustedHostKeysBase64?: string[];
  /** Jump chain for the SSH connection. */
  jump?: EngineJumpTarget;
  /** Same in-connection trust prompt used by normal mobile SSH sessions. */
  onServerKey?: ConnectOptions['onServerKey'];
  /** Same keyboard-interactive/OTP prompt used by normal mobile SSH sessions. */
  onInteractiveChallenge?: ConnectOptions['onInteractiveChallenge'];
  /** Authentication banner shown while this tunnel is opening. */
  onBanner?: ConnectOptions['onBanner'];
  /** Jump-chain progress shown in the shared connection stage UI. */
  onHopProgress?: ConnectOptions['onHopProgress'];
}

/**
 * Options for Tailscale tunnel transport.
 */
export interface RDTunnelTailscaleOptions {
  tailnetId: string;
  tailnetName?: string;
}

/**
 * Options for SSM tunnel transport. The caller should have already called
 * startSsmPortForward and obtained a local port. This type exists for
 * documentation; the actual flow wraps the existing SsmForward.
 */
export interface RDTunnelSsmOptions {
  /** Already-bound local port from startSsmPortForward. */
  localPort: number;
}

export interface OpenRemoteDesktopTunnelOptions {
  tunnelId: string;
  /** Target VNC/RDP host. */
  host: string;
  /** Target VNC/RDP port (e.g. 5900 for VNC, 3389 for RDP). */
  port: number;
  transport: RDTunnelTransport;
  /** Required when transport is 'tailscale'. */
  tailscale?: RDTunnelTailscaleOptions;
  /** Required when transport is 'ssh'. */
  ssh?: RDTunnelSshOptions;
  /** Required when transport is 'ssm'. */
  ssm?: RDTunnelSsmOptions;
}

export interface RDTunnelEndpoint {
  /** Null for direct when no native tunnel was created. */
  tunnelId: string | null;
  /** '127.0.0.1' for tunnelled, original host for direct. */
  host: string;
  /** Local listener port (tunnelled) or original port (direct). */
  port: number;
  transport: RDTunnelTransport;
  /** 256-bit secret written before VNC/RDP bytes on native loopback tunnels. */
  authToken?: string;
}

// ---------- Credential helpers (reuse from goEngine.ts) ----------

function credentialFieldsOf(
  credential: EngineCredential,
): Record<string, unknown> {
  switch (credential.type) {
    case 'password':
      return { authType: 'password', password: credential.password };
    case 'key':
      return {
        authType: 'privateKey',
        privateKeyPem: credential.privateKey,
        ...(credential.passphrase ? { passphrase: credential.passphrase } : {}),
      };
    case 'certificate':
      return {
        authType: 'certificate',
        privateKeyPem: credential.privateKey,
        certificateText: credential.certificate,
        ...(credential.passphrase ? { passphrase: credential.passphrase } : {}),
      };
  }
}

function jumpPayload(jump: EngineJumpTarget): Record<string, unknown> {
  const keys = jump.trustedHostKeysBase64?.filter(Boolean) ?? [];
  return {
    host: jump.host,
    port: jump.port,
    username: jump.username,
    trustedHostKeyBase64: keys[0] ?? '',
    ...(keys.length ? { trustedHostKeysBase64: keys } : {}),
    ...credentialFieldsOf(jump.credential),
    ...(jump.jump ? { jump: jumpPayload(jump.jump) } : {}),
  };
}

// ---------- Native module access ----------

type GoSshEngineNative = {
  openRemoteDesktopTunnel(requestJson: string): Promise<string>;
  closeRemoteDesktopTunnel(tunnelId: string): Promise<void>;
};

function requireNative(): GoSshEngineNative {
  const mod = NativeModules.GoSshEngineModule as GoSshEngineNative | undefined;
  if (!mod) {
    throw new Error('GoSshEngineModule is not available');
  }
  return mod;
}

// ---------- Public API ----------

/**
 * Opens a remote desktop tunnel. For 'direct' transport, no native listener is
 * created; for 'tailscale'/'ssh', the Go engine opens a 127.0.0.1 ephemeral
 * listener. For 'ssm', use the existing startSsmPortForward first.
 */
export async function openRemoteDesktopTunnel(
  options: OpenRemoteDesktopTunnelOptions,
): Promise<RDTunnelEndpoint> {
  if (options.transport === 'ssm' && !options.ssm) {
    throw new Error('rdtunnel: ssm options are required for ssm transport');
  }

  const payload = buildNativePayload(options);
  const openNativeTunnel = () =>
    requireNative().openRemoteDesktopTunnel(JSON.stringify(payload));
  const resultJson =
    options.transport === 'ssh' && options.ssh
      ? await runWithGoConnectionEvents(
          {
            connectionId: options.tunnelId,
            host: options.ssh.host,
            port: options.ssh.port,
            onServerKey: options.ssh.onServerKey ?? (async () => false),
            onInteractiveChallenge: options.ssh.onInteractiveChallenge,
            onBanner: options.ssh.onBanner,
            onHopProgress: options.ssh.onHopProgress,
          },
          openNativeTunnel,
        )
      : await openNativeTunnel();
  const result = JSON.parse(resultJson) as {
    tunnelId: string;
    host: string;
    port: number;
    transport: string;
    authToken?: string;
  };
  const transport = result.transport as RDTunnelTransport;
  if (
    transport !== 'direct' &&
    !/^[0-9a-f]{64}$/.test(result.authToken ?? '')
  ) {
    await requireNative()
      .closeRemoteDesktopTunnel(result.tunnelId)
      .catch(() => undefined);
    throw new Error(
      'rdtunnel: native loopback authentication token is missing or invalid',
    );
  }

  return {
    tunnelId: result.tunnelId,
    host: result.host,
    port: result.port,
    transport,
    ...(result.authToken ? { authToken: result.authToken } : {}),
  };
}

/**
 * Closes a remote desktop tunnel by ID. Safe to call on a direct tunnel or one
 * that is already closed.
 */
export async function closeRemoteDesktopTunnel(
  tunnelId: string | null,
): Promise<void> {
  if (!tunnelId) {
    return;
  }
  await requireNative().closeRemoteDesktopTunnel(tunnelId);
}

// ---------- Payload building ----------

function buildNativePayload(
  options: OpenRemoteDesktopTunnelOptions,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: options.tunnelId,
    host: options.host,
    port: options.port,
    transport: options.transport,
  };

  switch (options.transport) {
    case 'direct':
      return base;

    case 'tailscale': {
      if (!options.tailscale) {
        throw new Error('rdtunnel: tailscale options required');
      }
      return {
        ...base,
        tailnetId: options.tailscale.tailnetId,
        ...(options.tailscale.tailnetName
          ? { tailnetName: options.tailscale.tailnetName }
          : {}),
      };
    }

    case 'ssh': {
      if (!options.ssh) {
        throw new Error('rdtunnel: ssh options required');
      }
      const ssh = options.ssh;
      return {
        ...base,
        // SSH connection fields (ConnectPayload)
        host: ssh.host,
        port: ssh.port,
        username: ssh.username,
        ...credentialFieldsOf(ssh.credential),
        ...(ssh.tailnet
          ? {
              tailnetId: ssh.tailnet.tailnetId,
              ...(ssh.tailnet.tailnetName
                ? { tailnetName: ssh.tailnet.tailnetName }
                : {}),
            }
          : {}),
        ...(ssh.jump ? { jump: jumpPayload(ssh.jump) } : {}),
        ...(ssh.trustedHostKeysBase64?.length
          ? {
              trustedHostKeyBase64: ssh.trustedHostKeysBase64[0],
              trustedHostKeysBase64: ssh.trustedHostKeysBase64,
            }
          : {}),
        targetHost: ssh.targetHost ?? 'localhost',
        targetPort: ssh.targetPort ?? options.port,
      };
    }

    case 'ssm':
      return {
        ...base,
        localPort: options.ssm?.localPort,
      };

    default:
      return base;
  }
}
