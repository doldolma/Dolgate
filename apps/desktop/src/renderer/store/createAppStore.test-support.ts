import { vi } from "vitest";
import type {
  DesktopApi,
  HostContainerLogsSnapshot,
  HostDraft,
  HostRecord,
} from "@shared";
import { DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS, isSshHostRecord } from "@shared";
import type { HostContainersTabState } from "./createAppStore";

export function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

export function createEcsHost(): HostRecord {
  return {
    id: "ecs-host-1",
    kind: "aws-ecs",
    label: "gridwiz-ecs",
    awsProfileId: "profile-default",
    awsProfileName: "default",
    awsRegion: "ap-northeast-2",
    awsEcsClusterArn: "arn:aws:ecs:ap-northeast-2:123456789012:cluster/prod",
    awsEcsClusterName: "prod",
    groupName: "Servers",
    terminalThemeId: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  };
}

export function createAwsEc2Host(): HostRecord {
  return {
    id: "aws-host-1",
    kind: "aws-ec2",
    label: "AWS Linux",
    awsProfileId: "profile-default",
    awsProfileName: "default",
    awsRegion: "ap-northeast-2",
    awsInstanceId: "i-aws",
    awsAvailabilityZone: "ap-northeast-2a",
    awsInstanceName: "aws-linux",
    awsPlatform: "Linux/UNIX",
    awsPrivateIp: "10.0.0.20",
    awsState: "running",
    awsSshUsername: "ubuntu",
    awsSshPort: 22,
    awsSshMetadataStatus: "ready",
    awsSshMetadataError: null,
    groupName: "Servers",
    terminalThemeId: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  };
}

export function createContainerTab(
  hostId: string,
  options: Partial<HostContainersTabState> = {},
): HostContainersTabState {
  return {
    kind: "host-containers",
    hostId,
    lifecycleId: null,
    title: `${hostId} · Containers`,
    runtime: null,
    unsupportedReason: null,
    connectionProgress: null,
    items: [],
    selectedContainerId: null,
    activePanel: "overview",
    isLoading: false,
    details: null,
    detailsLoading: false,
    logs: null,
    logsState: "idle",
    logsLoading: false,
    logsFollowEnabled: false,
    logsTailWindow: 200,
    logsRangeMode: "recent",
    logsRelativeRange: {
      presetKey: "30m",
      amount: "30",
      unit: "minute",
    },
    logsAbsoluteRange: null,
    logsSearchQuery: "",
    logsSearchMode: null,
    logsSearchLoading: false,
    logsSearchResult: null,
    metricsSamples: [],
    metricsState: "idle",
    metricsLoading: false,
    pendingAction: null,
    containerTunnelStatesByContainerId: {},
    ecsSnapshot: null,
    ecsMetricsWarning: null,
    ecsMetricsLoadedAt: null,
    ecsMetricsLoading: false,
    ecsUtilizationHistoryByServiceName: {},
    ecsLogsByServiceName: {},
    ecsSelectedServiceName: null,
    ecsActivePanel: "overview",
    ecsTunnelStatesByServiceName: {},
    ...options,
  };
}

export function createContainerSummary() {
  return {
    id: "container-1",
    name: "app",
    runtime: "docker" as const,
    image: "nginx:latest",
    status: "Up 1 minute",
    createdAt: "2025-01-01T00:00:00.000Z",
    ports: "80/tcp",
  };
}

export function createContainerDetails() {
  return {
    id: "container-1",
    name: "app",
    runtime: "docker" as const,
    image: "nginx:latest",
    status: "running",
    createdAt: "2025-01-01T00:00:00.000Z",
    command: "nginx -g daemon off;",
    entrypoint: "/docker-entrypoint.sh",
    mounts: [],
    networks: [],
    ports: [],
    environment: [],
    labels: [],
  };
}

export function createUntrustedHostProbe() {
  return {
    hostId: "host-1",
    hostLabel: "Prod",
    host: "prod.example.com",
    port: 22,
    algorithm: "ssh-ed25519",
    publicKeyBase64: "AAAATEST",
    fingerprintSha256: "SHA256:test",
    status: "untrusted" as const,
    existing: null,
  };
}

export function createMockApi(): DesktopApi {
  let sessionCounter = 0;

  const api = {
    auth: {
      getState: vi.fn().mockResolvedValue({
        status: "authenticated",
        session: {
          user: { id: "user-1", email: "user@example.com" },
          tokens: {
            accessToken: "access",
            refreshToken: "refresh",
            expiresInSeconds: 900,
          },
          vaultBootstrap: {
            keyBase64: "ZmFrZS12YXVsdC1rZXk=",
          },
          offlineLease: {
            token: "offline-token",
            issuedAt: "2025-01-01T00:00:00.000Z",
            expiresAt: "2025-01-04T00:00:00.000Z",
            verificationPublicKeyPem: "-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----",
          },
          syncServerTime: "2025-01-01T00:00:00.000Z",
        },
        errorMessage: null,
      }),
      bootstrap: vi.fn().mockResolvedValue({
        status: "authenticated",
        session: {
          user: { id: "user-1", email: "user@example.com" },
          tokens: {
            accessToken: "access",
            refreshToken: "refresh",
            expiresInSeconds: 900,
          },
          vaultBootstrap: {
            keyBase64: "ZmFrZS12YXVsdC1rZXk=",
          },
          offlineLease: {
            token: "offline-token",
            issuedAt: "2025-01-01T00:00:00.000Z",
            expiresAt: "2025-01-04T00:00:00.000Z",
            verificationPublicKeyPem: "-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----",
          },
          syncServerTime: "2025-01-01T00:00:00.000Z",
        },
        errorMessage: null,
      }),
      retryOnline: vi.fn().mockResolvedValue({
        status: "authenticated",
        session: {
          user: { id: "user-1", email: "user@example.com" },
          tokens: {
            accessToken: "access",
            refreshToken: "refresh",
            expiresInSeconds: 900,
          },
          vaultBootstrap: {
            keyBase64: "ZmFrZS12YXVsdC1rZXk=",
          },
          offlineLease: {
            token: "offline-token",
            issuedAt: "2025-01-01T00:00:00.000Z",
            expiresAt: "2025-01-04T00:00:00.000Z",
            verificationPublicKeyPem: "-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----",
          },
          syncServerTime: "2025-01-01T00:00:00.000Z",
        },
        errorMessage: null,
      }),
      beginBrowserLogin: vi.fn().mockResolvedValue(undefined),
      reopenBrowserLogin: vi.fn().mockResolvedValue(undefined),
      cancelBrowserLogin: vi.fn().mockResolvedValue(undefined),
      logout: vi.fn().mockResolvedValue(undefined),
      onEvent: vi.fn().mockReturnValue(() => undefined),
    },
    sync: {
      bootstrap: vi.fn().mockResolvedValue({
        status: "ready",
        lastSuccessfulSyncAt: "2025-01-01T00:00:00.000Z",
        pendingPush: false,
        errorMessage: null,
      }),
      pushDirty: vi.fn().mockResolvedValue({
        status: "ready",
        lastSuccessfulSyncAt: "2025-01-01T00:00:00.000Z",
        pendingPush: false,
        errorMessage: null,
      }),
      status: vi.fn().mockResolvedValue({
        status: "ready",
        lastSuccessfulSyncAt: "2025-01-01T00:00:00.000Z",
        pendingPush: false,
        errorMessage: null,
      }),
      exportDecryptedSnapshot: vi.fn().mockResolvedValue({
        groups: [],
        hosts: [],
        secrets: [],
        knownHosts: [],
        portForwards: [],
        dnsOverrides: [],
        preferences: [],
      }),
    },
    hosts: {
      list: vi.fn().mockResolvedValue([
        {
          id: "host-1",
          kind: "ssh",
          label: "Prod",
          hostname: "prod.example.com",
          port: 22,
          username: "ubuntu",
          authType: "password",
          privateKeyPath: null,
          secretRef: "host:host-1",
          groupName: "Servers",
          terminalThemeId: null,
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
        },
        {
          id: "rdp-host-1",
          kind: "rdp",
          label: "Win Box",
          hostname: "192.168.200.27",
          port: 3389,
          username: "user",
          domain: null,
          secretRef: "host:rdp-host-1",
          groupName: null,
          terminalThemeId: null,
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
        },
      ]),
      create: vi.fn(),
      // 실제 API 는 갱신된 레코드를 돌려준다. undefined 를 주면 호출부가 그 값을 쓰다 터진다.
      update: vi.fn().mockImplementation(async (id, draft) => ({
        ...draft,
        id,
        updatedAt: "2025-01-02T00:00:00.000Z",
      })),
      remove: vi.fn().mockResolvedValue(undefined),
      setFavorite: vi.fn().mockResolvedValue(null),
    },
    aws: {
      listProfiles: vi.fn().mockResolvedValue([]),
      createProfile: vi.fn().mockResolvedValue(undefined),
      prepareSsoProfile: vi.fn().mockResolvedValue({
        preparationToken: "prep-token",
        profileName: "corp-sso",
        ssoSessionName: "corp-sso",
        ssoStartUrl: "https://example.awsapps.com/start",
        ssoRegion: "ap-northeast-2",
        region: "ap-northeast-2",
        accounts: [],
        rolesByAccountId: {},
        defaultAccountId: null,
        defaultRoleName: null,
      }),
      getProfileDetails: vi.fn().mockResolvedValue({
        profileName: "default",
        available: true,
        isSsoProfile: false,
        isAuthenticated: false,
        configuredRegion: null,
        accountId: null,
        arn: null,
        errorMessage: null,
        kind: "static",
        maskedAccessKeyId: null,
        hasSecretAccessKey: false,
        hasSessionToken: false,
        roleArn: null,
        sourceProfile: null,
        credentialProcess: null,
        ssoSession: null,
        ssoStartUrl: null,
        ssoRegion: null,
        ssoAccountId: null,
        ssoRoleName: null,
        referencedByProfileNames: [],
        orphanedSsoSessionName: null,
      }),
      updateProfile: vi.fn().mockResolvedValue(undefined),
      renameProfile: vi.fn().mockResolvedValue(undefined),
      deleteProfile: vi.fn().mockResolvedValue(undefined),
      getProfileStatus: vi.fn().mockResolvedValue({
        profileName: "default",
        available: true,
        isSsoProfile: false,
        isAuthenticated: false,
        accountId: null,
        arn: null,
        errorMessage: null,
      }),
      getProfileStatusById: vi.fn().mockResolvedValue({
        profileName: "default",
        available: true,
        isSsoProfile: false,
        isAuthenticated: true,
        configuredRegion: "ap-northeast-2",
        accountId: null,
        arn: null,
        errorMessage: null,
      }),
      login: vi.fn().mockResolvedValue(undefined),
      loginById: vi.fn().mockResolvedValue(undefined),
      listRegions: vi.fn().mockResolvedValue([]),
      listEc2Instances: vi.fn().mockResolvedValue([]),
      listEcsClusters: vi.fn().mockResolvedValue([]),
      inspectHostSshMetadata: vi.fn().mockResolvedValue({
        sshPort: 22,
        recommendedUsername: "ubuntu",
        usernameCandidates: ["ubuntu"],
        status: "ready",
        errorMessage: null,
      }),
      loadHostSshMetadata: vi.fn().mockImplementation(async (hostId: string) => ({
        id: hostId,
        kind: "aws-ec2",
        label: "AWS Linux",
        awsProfileId: "profile-default",
        awsProfileName: "default",
        awsRegion: "ap-northeast-2",
        awsInstanceId: "i-aws",
        awsAvailabilityZone: "ap-northeast-2a",
        awsInstanceName: "aws-linux",
        awsPlatform: "Linux/UNIX",
        awsPrivateIp: "10.0.0.20",
        awsState: "running",
        awsSshUsername: "ubuntu",
        awsSshPort: 22,
        awsSshMetadataStatus: "ready",
        awsSshMetadataError: null,
        groupName: "Servers",
        tags: [],
        terminalThemeId: null,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      })),
      loadEcsClusterSnapshot: vi.fn().mockResolvedValue({
        profileName: "default",
        region: "ap-northeast-2",
        cluster: {
          clusterArn: "arn:aws:ecs:ap-northeast-2:123456789012:cluster/prod",
          clusterName: "prod",
          status: "ACTIVE",
          activeServicesCount: 2,
          runningTasksCount: 3,
          pendingTasksCount: 1,
        },
        services: [
          {
            serviceArn: "arn:aws:ecs:ap-northeast-2:123456789012:service/prod/api",
            serviceName: "api",
            status: "ACTIVE",
            rolloutState: "COMPLETED",
            desiredCount: 2,
            runningCount: 2,
            pendingCount: 0,
            launchType: "FARGATE",
            servicePorts: [],
            exposureKinds: [],
            cpuUtilizationPercent: null,
            memoryUtilizationPercent: null,
            capacityProviderSummary: null,
            configuredCpu: "512",
            configuredMemory: "1024",
            taskDefinitionArn: "arn:aws:ecs:ap-northeast-2:123456789012:task-definition/api:7",
            taskDefinitionRevision: 7,
            latestEventMessage: "steady state",
          },
        ],
        metricsWarning: null,
        loadedAt: "2025-01-01T00:00:00.000Z",
      }),
      loadEcsClusterUtilization: vi.fn().mockResolvedValue({
        loadedAt: "2025-01-01T00:00:10.000Z",
        warning: null,
        services: [
          {
            serviceName: "api",
            cpuUtilizationPercent: 23.4,
            memoryUtilizationPercent: 61.2,
            cpuHistory: [
              {
                timestamp: "2025-01-01T00:00:00.000Z",
                value: 22.1,
              },
              {
                timestamp: "2025-01-01T00:01:00.000Z",
                value: 23.4,
              },
            ],
            memoryHistory: [
              {
                timestamp: "2025-01-01T00:00:00.000Z",
                value: 59.8,
              },
              {
                timestamp: "2025-01-01T00:01:00.000Z",
                value: 61.2,
              },
            ],
          },
        ],
      }),
      loadEcsServiceActionContext: vi.fn().mockResolvedValue({
        serviceName: "api",
        serviceArn: "arn:aws:ecs:ap-northeast-2:123456789012:service/prod/api",
        taskDefinitionArn:
          "arn:aws:ecs:ap-northeast-2:123456789012:task-definition/api:7",
        taskDefinitionRevision: 7,
        containers: [
          {
            containerName: "api",
            ports: [{ port: 8080, protocol: "tcp" }],
            execEnabled: true,
            logSupport: {
              containerName: "api",
              supported: true,
              logGroupName: "/ecs/api",
              logRegion: "ap-northeast-2",
              logStreamPrefix: "ecs",
            },
          },
        ],
        runningTasks: [
          {
            taskArn: "arn:aws:ecs:ap-northeast-2:123456789012:task/prod/api-1",
            taskId: "api-1",
            lastStatus: "RUNNING",
            enableExecuteCommand: true,
            containers: [
              {
                containerName: "api",
                lastStatus: "RUNNING",
                runtimeId: "runtime-1",
              },
            ],
          },
        ],
        deployments: [],
        events: [],
      }),
      loadEcsServiceLogs: vi.fn().mockResolvedValue({
        serviceName: "api",
        entries: [],
        taskOptions: [],
        containerOptions: [],
        followCursor: null,
        loadedAt: "2025-01-01T00:00:00.000Z",
        unsupportedReason: null,
      }),
      openEcsExecShell: vi
        .fn()
        .mockResolvedValue({ sessionId: "local-session-ecs-1" }),
      startEcsServiceTunnel: vi.fn().mockResolvedValue({
        ruleId: "ecs-service-tunnel:1",
        hostId: "ecs-host-1",
        transport: "ecs-task",
        bindAddress: "127.0.0.1",
        bindPort: 4200,
        status: "running",
        updatedAt: "2025-01-01T00:00:00.000Z",
        startedAt: "2025-01-01T00:00:00.000Z",
        mode: "local",
        method: "ssm-remote-host",
      }),
      stopEcsServiceTunnel: vi.fn().mockResolvedValue(undefined),
      listEcsTaskTunnelServices: vi.fn().mockResolvedValue([]),
      loadEcsTaskTunnelService: vi.fn().mockResolvedValue({
        serviceName: "api",
        containers: [],
      }),
    },
    warpgate: {
      testConnection: vi.fn().mockResolvedValue({
        baseUrl: "https://warpgate.example.com",
        sshHost: "warpgate.example.com",
        sshPort: 2222,
        username: "example.user",
      }),
      getConnectionInfo: vi.fn().mockResolvedValue({
        baseUrl: "https://warpgate.example.com",
        sshHost: "warpgate.example.com",
        sshPort: 2222,
        username: "example.user",
      }),
      listSshTargets: vi.fn().mockResolvedValue([]),
      startBrowserImport: vi.fn().mockResolvedValue({ attemptId: "attempt-1" }),
      cancelBrowserImport: vi.fn().mockResolvedValue(undefined),
      onImportEvent: vi.fn(() => () => undefined),
    },
    hostTransfer: {
      previewExport: vi.fn().mockResolvedValue({
        selectedHostCount: 1,
        dolgateHostCount: 1,
        opensshHostCount: 1,
        opensshDependencyCount: 0,
        opensshSkippedCount: 0,
        opensshWarnings: [],
      }),
      exportSelection: vi.fn().mockResolvedValue({
        canceled: false,
        savedPath: "/tmp/hosts.dolgate",
        exportedHostCount: 1,
        skippedHostCount: 0,
        warnings: [],
      }),
      pickImportFile: vi.fn().mockResolvedValue(null),
      probeImport: vi.fn(),
      commitImport: vi.fn(),
      discardImport: vi.fn().mockResolvedValue(undefined),
    },
    groups: {
      list: vi.fn().mockResolvedValue([
        {
          id: "group-1",
          name: "Servers",
          path: "Servers",
          parentPath: null,
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
        },
      ]),
      create: vi
        .fn()
        .mockImplementation(
          async (name: string, parentPath?: string | null) => ({
            id: "group-2",
            name,
            path: parentPath ? `${parentPath}/${name}` : name,
            parentPath: parentPath ?? null,
            createdAt: "2025-01-03T00:00:00.000Z",
            updatedAt: "2025-01-03T00:00:00.000Z",
          }),
        ),
      remove: vi.fn().mockResolvedValue({
        groups: [],
        hosts: [],
      }),
      move: vi.fn().mockImplementation(async (path: string, targetParentPath: string | null) => {
        const segments = path.split("/");
        const leafName = segments[segments.length - 1] ?? path;
        const nextPath = targetParentPath ? `${targetParentPath}/${leafName}` : leafName;
        return {
          groups: [
            {
              id: "group-1",
              name: leafName,
              path: nextPath,
              parentPath: targetParentPath,
              createdAt: "2025-01-01T00:00:00.000Z",
              updatedAt: "2025-01-04T00:00:00.000Z",
            },
          ],
          hosts: [
            {
              id: "host-1",
              kind: "ssh",
              label: "Prod",
              hostname: "prod.example.com",
              port: 22,
              username: "ubuntu",
              authType: "password",
              privateKeyPath: null,
              secretRef: "host:host-1",
              groupName: nextPath,
              terminalThemeId: null,
              createdAt: "2025-01-01T00:00:00.000Z",
              updatedAt: "2025-01-04T00:00:00.000Z",
            },
          ],
          nextPath,
        };
      }),
      rename: vi.fn().mockImplementation(async (path: string, name: string) => {
        const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
        const nextPath = parentPath ? `${parentPath}/${name}` : name;
        return {
          groups: [
            {
              id: "group-1",
              name,
              path: nextPath,
              parentPath,
              createdAt: "2025-01-01T00:00:00.000Z",
              updatedAt: "2025-01-04T00:00:00.000Z",
            },
          ],
          hosts: [
            {
              id: "host-1",
              kind: "ssh",
              label: "Prod",
              hostname: "prod.example.com",
              port: 22,
              username: "ubuntu",
              authType: "password",
              privateKeyPath: null,
              secretRef: "host:host-1",
              groupName: nextPath,
              terminalThemeId: null,
              createdAt: "2025-01-01T00:00:00.000Z",
              updatedAt: "2025-01-04T00:00:00.000Z",
            },
          ],
          nextPath,
        };
      }),
    },
    ssh: {
      connect: vi.fn().mockImplementation(async () => {
        sessionCounter += 1;
        return { sessionId: `session-${sessionCounter}` };
      }),
      connectLocal: vi.fn().mockImplementation(async () => {
        sessionCounter += 1;
        return { sessionId: `local-session-${sessionCounter}` };
      }),
      write: vi.fn().mockResolvedValue(undefined),
      writeBinary: vi.fn().mockResolvedValue(undefined),
      resize: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      respondKeyboardInteractive: vi.fn().mockResolvedValue(undefined),
      tmuxSplitPane: vi.fn().mockResolvedValue(undefined),
      tmuxNewWindow: vi.fn().mockResolvedValue(undefined),
      tmuxSelectWindow: vi.fn().mockResolvedValue(undefined),
      tmuxSelectPane: vi.fn().mockResolvedValue(undefined),
      tmuxKillPane: vi.fn().mockResolvedValue(undefined),
      tmuxKillWindow: vi.fn().mockResolvedValue(undefined),
      tmuxKillSession: vi.fn().mockResolvedValue(undefined),
      tmuxRenameWindow: vi.fn().mockResolvedValue(undefined),
      tmuxDetach: vi.fn().mockResolvedValue(undefined),
      onEvent: vi.fn(),
      onData: vi.fn(),
    },
    rdp: {
      connect: vi.fn().mockResolvedValue({
        desktopWidth: 1920,
        desktopHeight: 1080,
        monitors: [{ index: 0, left: 0, top: 0, width: 1920, height: 1080 }],
        // 계정은 자격증명에만 있어 메인이 응답에 실어 보낸다 — 탭 hover 의 user@host 표기용.
        username: "WORKGROUP\\admin",
      }),
      disconnect: vi.fn().mockResolvedValue(undefined),
      sendInput: vi.fn(),
      trustCertificate: vi.fn().mockResolvedValue(undefined),
      requestResize: vi.fn(),
      sendClipboardText: vi.fn(),
      syncClipboard: vi.fn(),
      pickShareFolder: vi.fn().mockResolvedValue(null),
      onEvent: vi.fn(() => () => {}),
      onFrame: vi.fn(() => () => {}),
      onAudio: vi.fn(() => () => {}),
    },
    vnc: {
      // VNC 는 계정도 모니터 배치도 없다 — 서버가 자기 해상도와 이름만 알려 준다.
      connect: vi.fn().mockResolvedValue({
        desktopWidth: 1280,
        desktopHeight: 800,
        name: "lab-console",
      }),
      disconnect: vi.fn().mockResolvedValue(undefined),
      sendInput: vi.fn(),
      describeSession: vi.fn().mockResolvedValue(null),
      onEvent: vi.fn(() => () => {}),
      onFrame: vi.fn(() => () => {}),
    },
    serial: {
      connect: vi.fn().mockImplementation(async () => {
        sessionCounter += 1;
        return { sessionId: `serial-session-${sessionCounter}` };
      }),
      listPorts: vi.fn().mockResolvedValue([]),
    },
    containers: {
      beginLifecycle: vi.fn().mockResolvedValue({ lifecycleId: "lifecycle-1" }),
      reportLifecycleError: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue({
        hostId: "host-1",
        runtime: "docker",
        containers: [],
      }),
      inspect: vi.fn().mockResolvedValue({
        id: "container-1",
        name: "app",
        runtime: "docker",
        image: "nginx:latest",
        status: "running",
        createdAt: "2025-01-01T00:00:00.000Z",
        command: "nginx -g daemon off;",
        entrypoint: "/docker-entrypoint.sh",
        mounts: [],
        networks: [],
        environment: [],
        labels: [],
      }),
      logs: vi.fn().mockResolvedValue({
        hostId: "host-1",
        containerId: "container-1",
        runtime: "docker",
        lines: [],
        cursor: null,
      }),
      startTunnel: vi.fn().mockResolvedValue({
        ruleId: "container-service-tunnel:1",
        hostId: "host-1",
        transport: "container",
        bindAddress: "127.0.0.1",
        bindPort: 43110,
        status: "running",
        updatedAt: "2025-01-01T00:00:10.000Z",
        startedAt: "2025-01-01T00:00:05.000Z",
        mode: "local",
        method: "ssh-native",
      }),
      stopTunnel: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      restart: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      stats: vi.fn().mockResolvedValue({
        runtime: "docker",
        containerId: "container-1",
        recordedAt: "2025-01-01T00:00:00.000Z",
        cpuPercent: 10,
        memoryUsedBytes: 1024,
        memoryLimitBytes: 2048,
        memoryPercent: 50,
        networkRxBytes: 100,
        networkTxBytes: 200,
        blockReadBytes: 300,
        blockWriteBytes: 400,
      }),
      searchLogs: vi.fn().mockResolvedValue({
        hostId: "host-1",
        containerId: "container-1",
        runtime: "docker",
        query: "error",
        lines: [],
        matchCount: 0,
      }),
      openShell: vi.fn().mockResolvedValue({ sessionId: "session-container-1" }),
      release: vi.fn().mockResolvedValue(undefined),
      onConnectionProgress: vi.fn().mockReturnValue(() => undefined),
    },
    sessionShares: {
      start: vi.fn().mockResolvedValue({
        status: "active",
        shareUrl: "https://sync.example.com/share/share-1/token-1",
        inputEnabled: false,
        viewerCount: 0,
        errorMessage: null,
      }),
      updateSnapshot: vi.fn().mockResolvedValue(undefined),
      setInputEnabled: vi.fn().mockImplementation(async ({ inputEnabled }) => ({
        status: "active",
        shareUrl: "https://sync.example.com/share/share-1/token-1",
        inputEnabled,
        viewerCount: 0,
        errorMessage: null,
      })),
      stop: vi.fn().mockResolvedValue(undefined),
      openOwnerChatWindow: vi.fn().mockResolvedValue(undefined),
      sendOwnerChatMessage: vi.fn().mockResolvedValue(undefined),
      getOwnerChatSnapshot: vi.fn().mockResolvedValue({
        sessionId: "session-1",
        title: "Host Session",
        ownerNickname: "Host Session Owner",
        state: {
          status: "active",
          shareUrl: "https://sync.example.com/share/share-1/token-1",
          inputEnabled: false,
          viewerCount: 0,
          errorMessage: null,
        },
        messages: [],
      }),
      onEvent: vi.fn().mockReturnValue(() => undefined),
      onChatEvent: vi.fn().mockReturnValue(() => undefined),
    },
    shell: {
      pickPrivateKey: vi.fn(),
      pickSshCertificate: vi.fn(),
      pickOpenSshConfig: vi.fn(),
      pickXshellSessionFolder: vi.fn(),
      openExternal: vi.fn().mockResolvedValue(undefined),
    },
    window: {
      getState: vi.fn().mockResolvedValue({
        isMaximized: false,
      }),
      minimize: vi.fn().mockResolvedValue(undefined),
      maximize: vi.fn().mockResolvedValue(undefined),
      restore: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      onStateChanged: vi.fn().mockReturnValue(() => undefined),
    },
    tabs: {
      list: vi.fn().mockResolvedValue([]),
    },
    updater: {
      getState: vi.fn().mockResolvedValue({
        enabled: false,
        status: "idle",
        currentVersion: "0.1.0",
        dismissedVersion: null,
        release: null,
        progress: null,
        checkedAt: null,
        errorMessage: null,
      }),
      check: vi.fn().mockResolvedValue(undefined),
      download: vi.fn().mockResolvedValue(undefined),
      installAndRestart: vi.fn().mockResolvedValue(undefined),
      dismissAvailable: vi.fn().mockResolvedValue(undefined),
      onEvent: vi.fn(),
    },
    settings: {
      get: vi.fn().mockResolvedValue({
        theme: "system",
        homeHostViewMode: "grid",
        globalTerminalThemeId: "dolssh-dark",
        terminalFontFamily: "sf-mono",
        terminalFontSize: 13,
        terminalScrollbackLines: 5000,
        terminalLineHeight: 1,
        terminalLetterSpacing: 0,
        terminalMinimumContrastRatio: 1,
        terminalAltIsMeta: false,
        terminalWebglEnabled: true,
        sftpBrowserColumnWidths: { ...DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS },
        sftpConflictPolicy: "ask",
        sftpPreserveMtime: true,
        sftpPreservePermissions: false,
        serverUrl: "https://ssh.doldolma.com",
        serverUrlOverride: null,
        dismissedUpdateVersion: null,
        sessionReplayRetentionCount: 100,
        updatedAt: "2025-01-01T00:00:00.000Z",
      }),
      update: vi.fn().mockImplementation(async (input) => ({
        theme: input.theme ?? "system",
        homeHostViewMode: input.homeHostViewMode ?? "grid",
        globalTerminalThemeId: input.globalTerminalThemeId ?? "dolssh-dark",
        terminalFontFamily: input.terminalFontFamily ?? "sf-mono",
        terminalFontSize: input.terminalFontSize ?? 13,
        terminalScrollbackLines: input.terminalScrollbackLines ?? 5000,
        terminalLineHeight: input.terminalLineHeight ?? 1,
        terminalLetterSpacing: input.terminalLetterSpacing ?? 0,
        terminalMinimumContrastRatio: input.terminalMinimumContrastRatio ?? 1,
        terminalAltIsMeta: input.terminalAltIsMeta ?? false,
        terminalWebglEnabled: input.terminalWebglEnabled ?? true,
        sftpBrowserColumnWidths:
          input.sftpBrowserColumnWidths ?? { ...DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS },
        sftpConflictPolicy: input.sftpConflictPolicy ?? "ask",
        sftpPreserveMtime: input.sftpPreserveMtime ?? true,
        sftpPreservePermissions: input.sftpPreservePermissions ?? false,
        serverUrl:
          typeof input.serverUrlOverride === "string" &&
          input.serverUrlOverride.trim()
            ? input.serverUrlOverride.trim()
            : "https://ssh.doldolma.com",
        serverUrlOverride:
          typeof input.serverUrlOverride === "string" &&
          input.serverUrlOverride.trim()
            ? input.serverUrlOverride.trim()
            : null,
        dismissedUpdateVersion: input.dismissedUpdateVersion ?? null,
        sessionReplayRetentionCount: input.sessionReplayRetentionCount ?? 100,
        updatedAt: "2025-01-02T00:00:00.000Z",
      })),
    },
    sessionReplays: {
      open: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockRejectedValue(new Error("not implemented in test")),
    },
    portForwards: {
      list: vi.fn().mockResolvedValue({
        rules: [],
        runtimes: [],
      }),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue({
        ruleId: "forward-1",
        hostId: "host-1",
        transport: "ssh",
        mode: "local",
        bindAddress: "127.0.0.1",
        bindPort: 9000,
        status: "running",
        updatedAt: "2025-01-01T00:00:00.000Z",
      }),
      stop: vi.fn().mockResolvedValue(undefined),
      onEvent: vi.fn(),
    },
    dnsOverrides: {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
      setStaticActive: vi.fn(),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    snippets: {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    tailnet: {
      list: vi.fn().mockResolvedValue([]),
      save: vi.fn(),
      remove: vi.fn().mockResolvedValue(undefined),
      // 기본은 곧바로 running — tailnet 을 안 쓰는 테스트가 이 경로에 걸리지 않는다.
      test: vi.fn().mockResolvedValue({ id: "net-1", state: "running" }),
      forget: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
      snapshot: vi.fn().mockResolvedValue({ statuses: [] }),
      onStatus: vi.fn(() => () => undefined),
    },
    knownHosts: {
      list: vi.fn().mockResolvedValue([]),
      probeHost: vi.fn().mockResolvedValue({
        hostId: "host-1",
        hostLabel: "Prod",
        host: "prod.example.com",
        port: 22,
        algorithm: "ssh-ed25519",
        publicKeyBase64: "AAAATEST",
        fingerprintSha256: "SHA256:test",
        status: "trusted",
        existing: null,
      }),
      trust: vi.fn().mockResolvedValue({
        id: "known-1",
        host: "prod.example.com",
        port: 22,
        algorithm: "ssh-ed25519",
        publicKeyBase64: "AAAATEST",
        fingerprintSha256: "SHA256:test",
        createdAt: "2025-01-01T00:00:00.000Z",
        lastSeenAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      }),
      replace: vi.fn(),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    logs: {
      list: vi.fn().mockResolvedValue([]),
      clear: vi.fn().mockResolvedValue(undefined),
      onChanged: vi.fn().mockReturnValue(() => undefined),
    },
    keychain: {
      list: vi.fn().mockResolvedValue([]),
      load: vi.fn().mockResolvedValue(null),
      copyPassword: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
      cloneForHost: vi.fn().mockResolvedValue(undefined),
    },
    sshKeys: {
      generate: vi.fn().mockResolvedValue({
        secretRef: "secret:ssh-key",
        label: "Generated SSH Key",
        algorithm: "ssh-ed25519",
        publicKey: "ssh-ed25519 AAAATEST generated",
        fingerprintSha256: "SHA256:test",
      }),
      copyPublicKey: vi.fn().mockResolvedValue(undefined),
      install: vi.fn().mockResolvedValue({
        secretRef: "secret:ssh-key",
        mode: "installOnly",
        results: [],
      }),
    },
    files: {
      getHomeDirectory: vi.fn().mockResolvedValue("/Users/tester"),
      getDownloadsDirectory: vi
        .fn()
        .mockResolvedValue("/Users/tester/Downloads"),
      getPathForDroppedFile: vi.fn().mockReturnValue(null),
      listRoots: vi.fn().mockResolvedValue([{ label: "/", path: "/" }]),
      getParentPath: vi.fn().mockImplementation(async (targetPath: string) => {
        if (targetPath === "/Users/tester") {
          return "/Users";
        }
        return "/Users/tester";
      }),
      list: vi.fn().mockResolvedValue({
        path: "/Users/tester",
        entries: [
          {
            name: "Desktop",
            path: "/Users/tester/Desktop",
            isDirectory: true,
            size: 0,
            mtime: "2025-01-01T00:00:00.000Z",
            kind: "folder",
            permissions: "rwxr-xr-x",
          },
        ],
      }),
      mkdir: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockResolvedValue(undefined),
      chmod: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    termius: {
      probeLocal: vi.fn().mockResolvedValue({
        status: "no-data",
        warnings: [],
        counts: {
          groups: 0,
          hosts: 0,
          identities: 0,
          sshConfigs: 0,
          sshConfigIdentities: 0,
        },
        termiusDataDir: null,
        exportedAt: null,
      }),
      importSelection: vi.fn().mockResolvedValue({
        createdGroupCount: 0,
        createdHostCount: 0,
        createdSecretCount: 0,
        skippedHostCount: 0,
        warnings: [],
      }),
      discardSnapshot: vi.fn().mockResolvedValue(undefined),
    },
    openssh: {
      probeDefault: vi.fn().mockResolvedValue({
        snapshotId: "snapshot-1",
        sources: [],
        hosts: [],
        warnings: [],
        skippedExistingHostCount: 0,
        skippedDuplicateHostCount: 0,
      }),
      addFileToSnapshot: vi.fn().mockResolvedValue({
        snapshotId: "snapshot-1",
        sources: [],
        hosts: [],
        warnings: [],
        skippedExistingHostCount: 0,
        skippedDuplicateHostCount: 0,
      }),
      importSelection: vi.fn().mockResolvedValue({
        createdHostCount: 0,
        createdSecretCount: 0,
        skippedHostCount: 0,
        warnings: [],
      }),
      discardSnapshot: vi.fn().mockResolvedValue(undefined),
    },
    xshell: {
      probeDefault: vi.fn().mockResolvedValue({
        snapshotId: "snapshot-1",
        sources: [],
        groups: [],
        hosts: [],
        warnings: [],
        skippedExistingHostCount: 0,
        skippedDuplicateHostCount: 0,
      }),
      addFolderToSnapshot: vi.fn().mockResolvedValue({
        snapshotId: "snapshot-1",
        sources: [],
        groups: [],
        hosts: [],
        warnings: [],
        skippedExistingHostCount: 0,
        skippedDuplicateHostCount: 0,
      }),
      importSelection: vi.fn().mockResolvedValue({
        createdGroupCount: 0,
        createdHostCount: 0,
        createdSecretCount: 0,
        skippedHostCount: 0,
        warnings: [],
      }),
      discardSnapshot: vi.fn().mockResolvedValue(undefined),
    },
    sftp: {
      connect: vi.fn().mockImplementation(async (input) => ({
        id: input.endpointId,
        kind: "remote",
        hostId: input.hostId,
        title: "Prod",
        path: "/home/ubuntu",
        connectedAt: "2025-01-01T00:00:00.000Z",
      })),
      disconnect: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue({
        path: "/home/ubuntu",
        entries: [],
      }),
      mkdir: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockResolvedValue(undefined),
      chmod: vi.fn().mockResolvedValue(undefined),
      chown: vi.fn().mockResolvedValue(undefined),
      listPrincipals: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
      startTransfer: vi.fn().mockResolvedValue({
        id: "job-1",
        sourceLabel: "Local",
        targetLabel: "Prod",
        itemCount: 1,
        bytesTotal: 12,
        bytesCompleted: 0,
        status: "queued",
        startedAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      }),
      cancelTransfer: vi.fn().mockResolvedValue(undefined),
      pauseTransfer: vi.fn().mockResolvedValue(undefined),
      resumeTransfer: vi.fn().mockResolvedValue(undefined),
      onConnectionProgress: vi.fn(() => () => undefined),
      onTransferEvent: vi.fn(),
    },
  } as unknown as DesktopApi;

  api.bootstrap = {
    getInitialSnapshot: vi.fn(async () => {
      const [
        hosts,
        groups,
        tabs,
        settings,
        localHomePath,
        portForwardSnapshot,
        dnsOverrides,
        knownHosts,
        activityLogs,
        keychainEntries,
      ] = await Promise.all([
        api.hosts.list(),
        api.groups.list(),
        api.tabs.list(),
        api.settings.get(),
        api.files.getHomeDirectory(),
        api.portForwards.list(),
        api.dnsOverrides.list(),
        api.knownHosts.list(),
        api.logs.list(),
        api.keychain.list(),
      ]);
      const localHomeListing = await api.files.list(localHomePath);
      return {
        hosts,
        groups,
        tabs,
        settings,
        localHomePath,
        localHomeListing,
        portForwardSnapshot,
        dnsOverrides,
        knownHosts,
        activityLogs,
        keychainEntries,
      };
    }),
    getSyncedWorkspaceSnapshot: vi.fn(async () => ({
      hosts: await api.hosts.list(),
      groups: await api.groups.list(),
      settings: await api.settings.get(),
      portForwardSnapshot: await api.portForwards.list(),
      dnsOverrides: await api.dnsOverrides.list(),
      knownHosts: await api.knownHosts.list(),
      keychainEntries: await api.keychain.list(),
    })),
    onWorkspaceChanged: vi.fn(() => () => undefined),
  };

  return api;
}
