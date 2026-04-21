import { Linking } from "react-native";
import type {
  AwsEc2HostRecord,
  ManagedAwsProfilePayload,
} from "@dolssh/shared-core";
import { ensureAwsRuntimeGlobals } from "../src/lib/aws-runtime";
import {
  type AwsSsoBrowserLoginPrompt,
  recordAwsSsoCallbackUrl,
  resolveAwsSessionForHost,
} from "../src/lib/aws-session";

const mockStsSend = jest.fn();
const mockStartAwsSsoBrowserLogin = jest.fn();
const mockCompleteAwsSsoLoginHandoff = jest.fn();
const mockCancelAwsSsoBrowserLogin = jest.fn();
const mockStartAwsSsoLoopback = jest.fn();
const mockStopAwsSsoLoopback = jest.fn();
const mockOpenAwsSsoBrowser = jest.fn();
const mockCloseAwsSsoBrowser = jest.fn();
let linkingUrlHandler: ((event: { url: string }) => void) | null = null;

async function waitForLinkingUrlHandler(): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (linkingUrlHandler) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("linking url handler was not registered");
}

jest.mock("@aws-sdk/client-sts", () => ({
  STSClient: class {
    config: unknown;

    constructor(config: unknown) {
      this.config = config;
    }

    send(command: unknown) {
      return mockStsSend(command, this.config);
    }
  },
  GetCallerIdentityCommand: class {
    input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  },
  AssumeRoleCommand: class {
    input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

jest.mock("../src/lib/mobile", () => ({
  startAwsSsoBrowserLogin: (...args: unknown[]) =>
    mockStartAwsSsoBrowserLogin(...args),
  completeAwsSsoLoginHandoff: (...args: unknown[]) =>
    mockCompleteAwsSsoLoginHandoff(...args),
  cancelAwsSsoBrowserLogin: (...args: unknown[]) =>
    mockCancelAwsSsoBrowserLogin(...args),
}));

jest.mock("../src/lib/aws-sso-bridge", () => ({
  startAwsSsoLoopback: (...args: unknown[]) => mockStartAwsSsoLoopback(...args),
  stopAwsSsoLoopback: (...args: unknown[]) => mockStopAwsSsoLoopback(...args),
  openAwsSsoBrowser: (...args: unknown[]) => mockOpenAwsSsoBrowser(...args),
  closeAwsSsoBrowser: (...args: unknown[]) => mockCloseAwsSsoBrowser(...args),
}));

function createAwsHost(): AwsEc2HostRecord {
  return {
    id: "host-aws-1",
    kind: "aws-ec2",
    label: "AWS Instance",
    awsProfileId: "profile-1",
    awsProfileName: "prod",
    awsRegion: "ap-northeast-2",
    awsInstanceId: "i-0123456789",
    awsInstanceName: "web-1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("resolveAwsSessionForHost", () => {
  beforeEach(() => {
    ensureAwsRuntimeGlobals();
    jest.restoreAllMocks();
    jest.useFakeTimers();
    mockStsSend.mockReset();
    mockStartAwsSsoBrowserLogin.mockReset();
    mockCompleteAwsSsoLoginHandoff.mockReset();
    mockCancelAwsSsoBrowserLogin.mockReset();
    mockStartAwsSsoLoopback.mockReset();
    mockStopAwsSsoLoopback.mockReset();
    mockOpenAwsSsoBrowser.mockReset();
    mockCloseAwsSsoBrowser.mockReset();
    linkingUrlHandler = null;
    jest.spyOn(Linking, "addEventListener").mockImplementation((_, listener) => {
      linkingUrlHandler = listener as (event: { url: string }) => void;
      return {
        remove: jest.fn(() => {
          if (linkingUrlHandler === listener) {
            linkingUrlHandler = null;
          }
        }),
      } as never;
    });
    jest.spyOn(Linking, "getInitialURL").mockResolvedValue(null);
    mockStartAwsSsoLoopback.mockResolvedValue({
      redirectUri: "http://127.0.0.1:43111/oauth/callback",
    });
    mockStopAwsSsoLoopback.mockResolvedValue(undefined);
    mockOpenAwsSsoBrowser.mockResolvedValue(undefined);
    mockCloseAwsSsoBrowser.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("validates a static profile and builds session env", async () => {
    const host = createAwsHost();
    const profiles: ManagedAwsProfilePayload[] = [
      {
        id: "profile-1",
        name: "prod",
        kind: "static",
        region: "ap-northeast-2",
        accessKeyId: "AKIASTATIC",
        secretAccessKey: "secret",
        updatedAt: new Date().toISOString(),
      },
    ];
    mockStsSend.mockResolvedValue({});

    const result = await resolveAwsSessionForHost({
      host,
      profiles,
      serverUrl: "https://ssh.doldolma.com",
      authAccessToken: "access-token",
    });

    expect(result.profileName).toBe("prod");
    expect(result.region).toBe("ap-northeast-2");
    expect(result.envSpec.env).toEqual({
      AWS_ACCESS_KEY_ID: "AKIASTATIC",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_REGION: "ap-northeast-2",
    });
    expect(mockStsSend).toHaveBeenCalledTimes(1);
  });

  it("assumes a role profile through its source profile", async () => {
    const host = createAwsHost();
    host.awsProfileId = "profile-role";
    host.awsProfileName = "prod-role";

    const profiles: ManagedAwsProfilePayload[] = [
      {
        id: "profile-static",
        name: "prod-static",
        kind: "static",
        region: "ap-northeast-2",
        accessKeyId: "AKIASTATIC",
        secretAccessKey: "secret",
        updatedAt: new Date().toISOString(),
      },
      {
        id: "profile-role",
        name: "prod-role",
        kind: "role",
        region: "ap-northeast-2",
        sourceProfileId: "profile-static",
        roleArn: "arn:aws:iam::123456789012:role/demo",
        updatedAt: new Date().toISOString(),
      },
    ];
    mockStsSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Credentials: {
          AccessKeyId: "AKIAROLE",
          SecretAccessKey: "role-secret",
          SessionToken: "role-token",
        },
      })
      .mockResolvedValueOnce({});

    const result = await resolveAwsSessionForHost({
      host,
      profiles,
      serverUrl: "https://ssh.doldolma.com",
      authAccessToken: "access-token",
    });

    expect(result.profileName).toBe("prod-role");
    expect(result.envSpec.env).toEqual({
      AWS_ACCESS_KEY_ID: "AKIAROLE",
      AWS_SECRET_ACCESS_KEY: "role-secret",
      AWS_SESSION_TOKEN: "role-token",
      AWS_REGION: "ap-northeast-2",
    });
    expect(mockStsSend).toHaveBeenCalledTimes(3);
  });

  it("uses server-provided SSO credentials immediately when ready", async () => {
    const host = createAwsHost();
    const profiles: ManagedAwsProfilePayload[] = [
      {
        id: "profile-1",
        name: "prod",
        kind: "sso",
        region: "ap-northeast-2",
        ssoStartUrl: "https://gridwiz.awsapps.com/start",
        ssoRegion: "ap-northeast-2",
        ssoAccountId: "123456789012",
        ssoRoleName: "AdministratorAccess",
        updatedAt: new Date().toISOString(),
      },
    ];
    mockStartAwsSsoBrowserLogin.mockResolvedValue({
      loginId: "",
      status: "ready",
      credential: {
        accessKeyId: "AKIASSO",
        secretAccessKey: "sso-secret",
        sessionToken: "sso-token",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    mockStsSend.mockResolvedValue({});

    const result = await resolveAwsSessionForHost({
      host,
      profiles,
      serverUrl: "https://ssh.doldolma.com",
      authAccessToken: "access-token",
    });

    expect(mockStartAwsSsoBrowserLogin).toHaveBeenCalledWith(
      "https://ssh.doldolma.com",
      "access-token",
      expect.objectContaining({
        targetProfileName: "prod",
        sourceProfileName: "prod",
        redirectUri: "http://127.0.0.1:43111/oauth/callback",
      }),
    );
    expect(result.envSpec.env).toEqual({
      AWS_ACCESS_KEY_ID: "AKIASSO",
      AWS_SECRET_ACCESS_KEY: "sso-secret",
      AWS_SESSION_TOKEN: "sso-token",
      AWS_REGION: "ap-northeast-2",
    });
  });

  it("supports role chains whose source starts from sso", async () => {
    const host = createAwsHost();
    host.awsProfileId = "profile-role";
    host.awsProfileName = "prod-role";

    const profiles: ManagedAwsProfilePayload[] = [
      {
        id: "profile-sso",
        name: "source-sso",
        kind: "sso",
        region: "ap-northeast-2",
        ssoStartUrl: "https://gridwiz.awsapps.com/start",
        ssoRegion: "ap-northeast-2",
        ssoAccountId: "123456789012",
        ssoRoleName: "AdministratorAccess",
        updatedAt: new Date().toISOString(),
      },
      {
        id: "profile-role",
        name: "prod-role",
        kind: "role",
        region: "ap-northeast-2",
        sourceProfileId: "profile-sso",
        roleArn: "arn:aws:iam::123456789012:role/demo",
        updatedAt: new Date().toISOString(),
      },
    ];
    mockStartAwsSsoBrowserLogin.mockResolvedValue({
      loginId: "",
      status: "ready",
      credential: {
        accessKeyId: "AKIASSO",
        secretAccessKey: "sso-secret",
        sessionToken: "sso-token",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    mockStsSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Credentials: {
          AccessKeyId: "AKIAROLE",
          SecretAccessKey: "role-secret",
          SessionToken: "role-token",
        },
      })
      .mockResolvedValueOnce({});

    const result = await resolveAwsSessionForHost({
      host,
      profiles,
      serverUrl: "https://ssh.doldolma.com",
      authAccessToken: "access-token",
    });

    expect(result.profileName).toBe("prod-role");
    expect(result.envSpec.env).toEqual({
      AWS_ACCESS_KEY_ID: "AKIAROLE",
      AWS_SECRET_ACCESS_KEY: "role-secret",
      AWS_SESSION_TOKEN: "role-token",
      AWS_REGION: "ap-northeast-2",
    });
  });

  it("opens the system browser and resolves pending SSO login on automatic callback", async () => {
    jest.useRealTimers();
    const host = createAwsHost();
    const prompts: AwsSsoBrowserLoginPrompt[] = [];
    const profiles: ManagedAwsProfilePayload[] = [
      {
        id: "profile-1",
        name: "prod",
        kind: "sso",
        region: "ap-northeast-2",
        ssoStartUrl: "https://gridwiz.awsapps.com/start",
        ssoRegion: "ap-northeast-2",
        ssoAccountId: "123456789012",
        ssoRoleName: "AdministratorAccess",
        updatedAt: new Date().toISOString(),
      },
    ];
    mockStartAwsSsoBrowserLogin.mockResolvedValue({
      loginId: "login-1",
      status: "pending",
      browserUrl: "https://oidc.ap-northeast-2.amazonaws.com/authorize?code_challenge=abc",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    mockCompleteAwsSsoLoginHandoff.mockResolvedValue({
      loginId: "login-1",
      status: "ready",
      credential: {
        accessKeyId: "AKIASSO",
        secretAccessKey: "sso-secret",
        sessionToken: "sso-token",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    mockStsSend.mockResolvedValue({});
    const resultPromise = resolveAwsSessionForHost({
      host,
      profiles,
      serverUrl: "https://ssh.doldolma.com",
      authAccessToken: "access-token",
      presentLoginPrompt: (prompt) => {
        prompts.push(prompt);
      },
      dismissLoginPrompt: jest.fn(),
    });

    await Promise.resolve();
    await waitForLinkingUrlHandler();
    expect(mockOpenAwsSsoBrowser).toHaveBeenCalledWith(
      "https://oidc.ap-northeast-2.amazonaws.com/authorize?code_challenge=abc",
    );
    expect(prompts).toHaveLength(1);

    linkingUrlHandler?.({
      url: "dolgate://aws-sso/callback?code=auth-code-1&state=aws-state-1",
    });

    const result = await resultPromise;
    expect(mockCompleteAwsSsoLoginHandoff).toHaveBeenCalledWith(
      "https://ssh.doldolma.com",
      "access-token",
      "login-1",
      {
        code: "auth-code-1",
        state: "aws-state-1",
        error: undefined,
        errorDescription: undefined,
      },
    );
    expect(result.profileName).toBe("prod");
  });

  it("consumes a queued callback that arrived before the waiter subscribed", async () => {
    const host = createAwsHost();
    const profiles: ManagedAwsProfilePayload[] = [
      {
        id: "profile-1",
        name: "prod",
        kind: "sso",
        region: "ap-northeast-2",
        ssoStartUrl: "https://gridwiz.awsapps.com/start",
        ssoRegion: "ap-northeast-2",
        ssoAccountId: "123456789012",
        ssoRoleName: "AdministratorAccess",
        updatedAt: new Date().toISOString(),
      },
    ];
    mockStartAwsSsoBrowserLogin.mockResolvedValue({
      loginId: "login-1",
      status: "pending",
      browserUrl: "https://oidc.ap-northeast-2.amazonaws.com/authorize?code_challenge=abc",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    mockCompleteAwsSsoLoginHandoff.mockResolvedValue({
      loginId: "login-1",
      status: "ready",
      credential: {
        accessKeyId: "AKIASSO",
        secretAccessKey: "sso-secret",
        sessionToken: "sso-token",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    mockStsSend.mockResolvedValue({});

    expect(
      recordAwsSsoCallbackUrl(
        "dolgate://aws-sso/callback?code=queued-code&state=queued-state",
      ),
    ).toBe(true);

    const result = await resolveAwsSessionForHost({
      host,
      profiles,
      serverUrl: "https://ssh.doldolma.com",
      authAccessToken: "access-token",
    });

    expect(mockCompleteAwsSsoLoginHandoff).toHaveBeenCalledWith(
      "https://ssh.doldolma.com",
      "access-token",
      "login-1",
      {
        code: "queued-code",
        state: "queued-state",
        error: undefined,
        errorDescription: undefined,
      },
    );
    expect(result.profileName).toBe("prod");
  });

  it("rejects cyclic profile chains", async () => {
    const host = createAwsHost();
    host.awsProfileId = "profile-a";
    host.awsProfileName = "role-a";

    const profiles: ManagedAwsProfilePayload[] = [
      {
        id: "profile-a",
        name: "role-a",
        kind: "role",
        region: "ap-northeast-2",
        sourceProfileId: "profile-b",
        roleArn: "arn:aws:iam::123456789012:role/a",
        updatedAt: new Date().toISOString(),
      },
      {
        id: "profile-b",
        name: "role-b",
        kind: "role",
        region: "ap-northeast-2",
        sourceProfileId: "profile-a",
        roleArn: "arn:aws:iam::123456789012:role/b",
        updatedAt: new Date().toISOString(),
      },
    ];

    await expect(
      resolveAwsSessionForHost({
        host,
        profiles,
        serverUrl: "https://ssh.doldolma.com",
        authAccessToken: "access-token",
      }),
    ).rejects.toThrow("AWS 프로필 참조 체인을 해석하지 못했습니다.");
  });
});
