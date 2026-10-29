import { Linking } from "react-native";
import type {
  AwsEc2HostRecord,
  ManagedAwsProfilePayload,
} from "@dolssh/shared-core";
import { ensureAwsRuntimeGlobals } from "../src/lib/aws-runtime";
import {
  AwsKeyRejectedError,
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
        region: "ap-southeast-1",
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

  it.each(["profile-deleted", null])(
    "does not resolve a host profile by name when its profile ID is %s",
    async (profileId) => {
      const host = createAwsHost();
      host.awsProfileId = profileId;
      host.awsProfileName = "prod";
      const profiles: ManagedAwsProfilePayload[] = [
        {
          id: "profile-current",
          name: "prod",
          kind: "static",
          region: "ap-northeast-2",
          accessKeyId: "AKIASTATIC",
          secretAccessKey: "secret",
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
      ).rejects.toThrow("이 호스트에 연결할 AWS 프로필을 찾을 수 없습니다.");
      expect(mockStsSend).not.toHaveBeenCalled();
    },
  );

  it("assumes a role profile through its source profile", async () => {
    const host = createAwsHost();
    host.awsProfileId = "profile-role";
    host.awsProfileName = "prod-role";

    const profiles: ManagedAwsProfilePayload[] = [
      {
        id: "profile-static",
        name: "prod-static",
        kind: "static",
        region: "ap-southeast-1",
        accessKeyId: "AKIASTATIC",
        secretAccessKey: "secret",
        updatedAt: new Date().toISOString(),
      },
      {
        id: "profile-role",
        name: "prod-role",
        kind: "role",
        region: "us-east-1",
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

  // ── AWS 가 정적 키를 거절했을 때 — 어느 프로필의 키인지 알린다(팀 키를 다시 넣는 자리) ─────────────────
  function awsError(name: string, message: string): Error {
    return Object.assign(new Error(message), { name });
  }

  function staticAndRoleProfiles(): ManagedAwsProfilePayload[] {
    return [
      {
        id: "profile-static",
        name: "prod-static",
        kind: "static",
        region: "ap-southeast-1",
        accessKeyId: "AKIASTATIC",
        secretAccessKey: "secret",
        updatedAt: new Date().toISOString(),
      },
      {
        id: "profile-role",
        name: "prod-role",
        kind: "role",
        region: "us-east-1",
        sourceProfileId: "profile-static",
        roleArn: "arn:aws:iam::123456789012:role/demo",
        updatedAt: new Date().toISOString(),
      },
    ];
  }

  it.each([
    ["InvalidClientTokenId", "The security token included in the request is invalid."],
    ["SignatureDoesNotMatch", "The request signature we calculated does not match the signature you provided."],
  ])(
    "names the static profile whose key AWS rejected (%s) — on its own and as a role's source",
    async (code, message) => {
      const host = createAwsHost();
      host.awsProfileId = "profile-static";
      mockStsSend.mockRejectedValue(awsError(code, message));

      const direct = resolveAwsSessionForHost({
        host,
        profiles: staticAndRoleProfiles(),
        serverUrl: "https://ssh.doldolma.com",
        authAccessToken: "access-token",
      });
      await expect(direct).rejects.toBeInstanceOf(AwsKeyRejectedError);
      await expect(direct).rejects.toMatchObject({
        profileId: "profile-static",
        code,
        message,
      });

      host.awsProfileId = "profile-role";
      await expect(
        resolveAwsSessionForHost({
          host,
          profiles: staticAndRoleProfiles(),
          serverUrl: "https://ssh.doldolma.com",
          authAccessToken: "access-token",
        }),
      ).rejects.toMatchObject({ profileId: "profile-static", code });
      // 원본 키에서 멈췄다 — role 전환은 부르지 않았다.
      expect(mockStsSend).toHaveBeenCalledTimes(2);
    },
  );

  it("leaves other AWS failures as they were — role refused, the role's own credentials, network", async () => {
    const host = createAwsHost();
    host.awsProfileId = "profile-role";
    const resolve = () =>
      resolveAwsSessionForHost({
        host,
        profiles: staticAndRoleProfiles(),
        serverUrl: "https://ssh.doldolma.com",
        authAccessToken: "access-token",
      });

    // 원본 키는 맞고 role 전환이 거부됐다 — 키를 다시 넣어도 풀리지 않는다.
    mockStsSend
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(awsError("AccessDenied", "not authorized to perform: sts:AssumeRole"));
    const refused = await resolve().catch((error: unknown) => error);
    expect(refused).not.toBeInstanceOf(AwsKeyRejectedError);
    expect(refused).toMatchObject({ name: "AccessDenied" });

    // role 이 받은 임시 자격 증명이 거절된 것은 넣은 키의 탓이 아니다.
    mockStsSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Credentials: {
          AccessKeyId: "ASIAROLE",
          SecretAccessKey: "role-secret",
          SessionToken: "role-token",
        },
      })
      .mockRejectedValueOnce(
        awsError("InvalidClientTokenId", "The security token included in the request is invalid."),
      );
    const roleCredentials = await resolve().catch((error: unknown) => error);
    expect(roleCredentials).not.toBeInstanceOf(AwsKeyRejectedError);
    expect(roleCredentials).toMatchObject({ name: "InvalidClientTokenId" });

    host.awsProfileId = "profile-static";
    mockStsSend.mockRejectedValueOnce(new TypeError("Network request failed"));
    const offline = await resolve().catch((error: unknown) => error);
    expect(offline).not.toBeInstanceOf(AwsKeyRejectedError);
    expect(offline).toMatchObject({ message: "Network request failed" });
  });

  it("uses server-provided SSO credentials immediately when ready", async () => {
    const host = createAwsHost();
    const profiles: ManagedAwsProfilePayload[] = [
      {
        id: "profile-1",
        name: "prod",
        kind: "sso",
        region: "ap-southeast-1",
        ssoStartUrl: "https://acme-corp.awsapps.com/start",
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
        region: "ap-southeast-1",
        ssoStartUrl: "https://acme-corp.awsapps.com/start",
        ssoRegion: "ap-northeast-2",
        ssoAccountId: "123456789012",
        ssoRoleName: "AdministratorAccess",
        updatedAt: new Date().toISOString(),
      },
      {
        id: "profile-role",
        name: "prod-role",
        kind: "role",
        region: "us-east-1",
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
        ssoStartUrl: "https://acme-corp.awsapps.com/start",
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
        ssoStartUrl: "https://acme-corp.awsapps.com/start",
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
