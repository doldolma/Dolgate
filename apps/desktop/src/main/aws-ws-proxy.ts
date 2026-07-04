import type { AwsSshTunnelStartMessage, WsProxyTarget } from "@shared";

/**
 * Builds the sync-api WebSocket URL for the server-proxy SSH transport relay.
 * ssh-core authenticates with a Bearer header (WsProxyTarget.authToken), so the
 * access token is intentionally NOT embedded in the URL.
 */
export function buildAwsSshTunnelWsUrl(serverUrl: string): string {
  const url = new URL("/api/aws-ssh-tunnel/ws", serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function buildAwsWsProxyTarget(input: {
  serverUrl: string;
  accessToken: string;
  startMessage: AwsSshTunnelStartMessage;
}): WsProxyTarget {
  return {
    url: buildAwsSshTunnelWsUrl(input.serverUrl),
    authToken: input.accessToken,
    startMessage: input.startMessage,
  };
}

interface ServerProxyEnvResolver {
  buildServerProxySessionEnvSpec(
    profileName: string,
    region: string,
  ): Promise<{ env: Record<string, string>; unsetEnv: string[] }>;
}

/**
 * Resolves the AWS credential env for the target profile/region and assembles the
 * opaque start message the server relay needs to open the SSM tunnel + push the EIC
 * key on the desktop's behalf. Shared by every server-proxy connect path (SFTP,
 * tmux/shell, container shell) so they build an identical message.
 */
export async function buildAwsServerProxyStartMessage(
  awsService: ServerProxyEnvResolver,
  input: Omit<AwsSshTunnelStartMessage, "env" | "unsetEnv">,
): Promise<AwsSshTunnelStartMessage> {
  const envSpec = await awsService.buildServerProxySessionEnvSpec(
    input.profileName,
    input.region,
  );
  return { ...input, env: envSpec.env, unsetEnv: envSpec.unsetEnv };
}

interface ServerProxyAuthService {
  getServerUrl(): string;
  getAccessToken(): string;
  refreshSession(): Promise<{ status?: string } | null>;
}

/**
 * Runs a server-proxy connect, refreshing the access token once and retrying if the
 * first attempt fails. The WebSocket is opened by ssh-core (not the desktop), so we
 * cannot react to a 401 mid-stream — instead we retry the whole connect with a fresh
 * token. Mirrors the shell-session server-proxy auth retry.
 */
export async function runWithAwsServerProxyAuthRetry<T>(
  authService: ServerProxyAuthService,
  connect: (accessToken: string) => Promise<T>,
): Promise<T> {
  try {
    return await connect(authService.getAccessToken());
  } catch (error) {
    const refreshed = await authService.refreshSession().catch(() => null);
    if (refreshed?.status !== "authenticated") {
      throw error;
    }
    return connect(authService.getAccessToken());
  }
}
