import type { AwsSshTunnelStartMessage } from "@shared";

// URL 조립과 타깃 조립은 모바일도 같은 것을 써야 한다 — shared-core 에 두고 다시 내보낸다.
export {
  buildAwsSshTunnelWsUrl,
  buildAwsWsProxyTarget,
} from "@dolssh/shared-core";

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
