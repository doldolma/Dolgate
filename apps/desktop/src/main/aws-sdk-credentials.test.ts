import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDesktopStateStorageForTests } from "./state-storage";

const fromIniMock = vi.hoisted(() => vi.fn());

vi.mock("@aws-sdk/credential-provider-ini", () => ({
  fromIni: fromIniMock,
}));

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn((name: string) =>
      name === "userData"
        ? process.env.DOLSSH_USER_DATA_DIR ?? os.tmpdir()
        : os.tmpdir(),
    ),
    isPackaged: false,
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(value, "utf8")),
    decryptString: vi.fn((value: Buffer) => Buffer.from(value).toString("utf8")),
  },
}));

const tempDirectories: string[] = [];

async function createTempDirectory(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirectories.push(dir);
  return dir;
}

async function createTempAwsRoot(): Promise<{
  homeDir: string;
  awsRootDir: string;
}> {
  const homeDir = await createTempDirectory("dolssh-aws-sdk-provider-home-");
  const awsRootDir = path.join(homeDir, ".aws");
  await mkdir(awsRootDir, { recursive: true });
  return { homeDir, awsRootDir };
}

beforeEach(async () => {
  const userDataDir = await createTempDirectory("dolssh-aws-sdk-provider-userdata-");
  process.env.DOLSSH_USER_DATA_DIR = userDataDir;
  resetDesktopStateStorageForTests();
  vi.clearAllMocks();
});

afterEach(async () => {
  resetDesktopStateStorageForTests();
  delete process.env.DOLSSH_USER_DATA_DIR;
  delete process.env.HOME;
  delete process.env.USERPROFILE;
  delete process.env.AWS_PROFILE;
  delete process.env.AWS_DEFAULT_PROFILE;
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  delete process.env.AWS_SESSION_TOKEN;
  delete process.env.AWS_REGION;
  delete process.env.AWS_DEFAULT_REGION;
  await Promise.all(
    tempDirectories.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

describe("AwsService managed SDK credential provider", () => {
  it("creates fromIni providers against the managed shared config files and masks ambient env", async () => {
    const { AwsService } = await import("./aws-service");
    const managedRoot = await createTempAwsRoot();
    const externalRoot = await createTempAwsRoot();
    let observedEnv: Record<string, string | undefined> | null = null;
    fromIniMock.mockImplementation((init: Record<string, unknown>) => {
      expect(init).toMatchObject({
        profile: "corp-sso",
        configFilepath: path.join(managedRoot.awsRootDir, "config"),
        filepath: path.join(managedRoot.awsRootDir, "credentials"),
        ignoreCache: true,
      });
      return vi.fn().mockImplementation(async () => {
        observedEnv = {
          HOME: process.env.HOME,
          USERPROFILE: process.env.USERPROFILE,
          AWS_CONFIG_FILE: process.env.AWS_CONFIG_FILE,
          AWS_SHARED_CREDENTIALS_FILE: process.env.AWS_SHARED_CREDENTIALS_FILE,
          AWS_PROFILE: process.env.AWS_PROFILE,
          AWS_DEFAULT_PROFILE: process.env.AWS_DEFAULT_PROFILE,
          AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
          AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
          AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN,
          AWS_REGION: process.env.AWS_REGION,
          AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION,
        };
        return {
          accessKeyId: "ACCESS_KEY",
          secretAccessKey: "SECRET_KEY",
          sessionToken: "SESSION_TOKEN",
        };
      });
    });

    process.env.HOME = "C:\\ambient-home";
    process.env.USERPROFILE = "C:\\ambient-user";
    process.env.AWS_PROFILE = "ambient-profile";
    process.env.AWS_DEFAULT_PROFILE = "ambient-default";
    process.env.AWS_ACCESS_KEY_ID = "ambient-access";
    process.env.AWS_SECRET_ACCESS_KEY = "ambient-secret";
    process.env.AWS_SESSION_TOKEN = "ambient-session";
    process.env.AWS_REGION = "us-east-1";
    process.env.AWS_DEFAULT_REGION = "us-east-1";

    const service = new AwsService(managedRoot.awsRootDir, externalRoot.awsRootDir) as unknown as {
      getAwsSdkCredentialsProvider: (
        profileName: string,
        region: string,
      ) => () => Promise<Record<string, unknown>>;
    };

    const provider = service.getAwsSdkCredentialsProvider("corp-sso", "ap-northeast-2");

    await expect(provider()).resolves.toMatchObject({
      accessKeyId: "ACCESS_KEY",
      secretAccessKey: "SECRET_KEY",
      sessionToken: "SESSION_TOKEN",
    });
    expect(observedEnv).toEqual({
      HOME: managedRoot.homeDir,
      USERPROFILE: managedRoot.homeDir,
      AWS_CONFIG_FILE: path.join(managedRoot.awsRootDir, "config"),
      AWS_SHARED_CREDENTIALS_FILE: path.join(managedRoot.awsRootDir, "credentials"),
      AWS_PROFILE: undefined,
      AWS_DEFAULT_PROFILE: undefined,
      AWS_ACCESS_KEY_ID: undefined,
      AWS_SECRET_ACCESS_KEY: undefined,
      AWS_SESSION_TOKEN: undefined,
      AWS_REGION: undefined,
      AWS_DEFAULT_REGION: undefined,
    });
    expect(process.env.HOME).toBe("C:\\ambient-home");
    expect(process.env.USERPROFILE).toBe("C:\\ambient-user");
    expect(process.env.AWS_PROFILE).toBe("ambient-profile");
    expect(process.env.AWS_ACCESS_KEY_ID).toBe("ambient-access");
  });

  it("serializes concurrent provider executions so the managed env bridge does not overlap", async () => {
    const { AwsService } = await import("./aws-service");
    const managedRoot = await createTempAwsRoot();
    const externalRoot = await createTempAwsRoot();
    let activeCount = 0;
    let maxActiveCount = 0;
    let markFirstStarted!: () => void;
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    fromIniMock.mockImplementation((init: Record<string, unknown>) => {
      const profile = String(init.profile);
      return vi.fn().mockImplementation(async () => {
        activeCount += 1;
        maxActiveCount = Math.max(maxActiveCount, activeCount);
        try {
          if (profile === "first") {
            markFirstStarted?.();
            await firstGate;
          }
          return {
            accessKeyId: `${profile}-access`,
            secretAccessKey: `${profile}-secret`,
          };
        } finally {
          activeCount -= 1;
        }
      });
    });

    const service = new AwsService(managedRoot.awsRootDir, externalRoot.awsRootDir) as unknown as {
      getAwsSdkCredentialsProvider: (
        profileName: string,
        region: string,
      ) => () => Promise<Record<string, unknown>>;
    };

    const firstProvider = service.getAwsSdkCredentialsProvider("first", "ap-northeast-2");
    const secondProvider = service.getAwsSdkCredentialsProvider("second", "ap-northeast-2");

    const firstPromise = firstProvider();
    await firstStarted;
    const secondPromise = secondProvider();
    await Promise.resolve();
    expect(maxActiveCount).toBe(1);

    releaseFirst();
    await Promise.all([firstPromise, secondPromise]);

    expect(maxActiveCount).toBe(1);
  });
});
