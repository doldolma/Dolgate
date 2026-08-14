import { describe, expect, it, vi } from "vitest";
import type { HostRecord } from "@shared";
import { createTrustAuthServices } from "./trust-auth";
import type { SliceDeps } from "./context";

function sshHost(over: Partial<HostRecord> & { id: string }): HostRecord {
  return {
    kind: "ssh",
    label: over.id,
    hostname: `${over.id}.example`,
    port: 22,
    username: "u",
    authType: "password",
    privateKeyPath: null,
    secretRef: null,
    jumpHostId: null,
    startupCommand: null,
    groupName: null,
    tags: [],
    terminalThemeId: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    ...over,
  } as HostRecord;
}

function awsHost(over: Partial<HostRecord> & { id: string }): HostRecord {
  return {
    kind: "aws-ec2",
    label: over.id,
    awsProfileId: "p1",
    awsProfileName: "default",
    awsRegion: "ap-northeast-2",
    awsInstanceId: "i-abc",
    awsPlatform: "linux",
    groupName: null,
    tags: [],
    terminalThemeId: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    ...over,
  } as HostRecord;
}

function vncHost(over: Partial<HostRecord> & { id: string }): HostRecord {
  return {
    kind: "vnc",
    label: over.id,
    hostname: `${over.id}.example`,
    port: 5900,
    groupName: null,
    tags: [],
    terminalThemeId: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    ...over,
  } as HostRecord;
}

function setup(opts: {
  hosts: HostRecord[];
  knownHosts: Array<{ host: string; port: number }>;
}) {
  const probeHost = vi.fn(async () => ({ status: "trusted" }));
  const get = () =>
    ({ hosts: opts.hosts, knownHosts: opts.knownHosts }) as ReturnType<
      SliceDeps["get"]
    >;
  const deps = { api: { knownHosts: { probeHost } }, get } as unknown as SliceDeps;
  const services = createTrustAuthServices(deps);
  const set = vi.fn() as unknown as Parameters<
    typeof services.ensureTrustedHost
  >[0];
  return { services, set, probeHost };
}

const sshAction = (hostId: string) =>
  ({ kind: "ssh", hostId, cols: 80, rows: 24 }) as const;

// 호스트 키 확인은 **연결 안에서** 한다.
//
// 예전에는 연결 전에 키를 미리 읽어 왔다(프로브). 프로브도 점프 호스트에 인증해야 하므로, OTP 를
// 요구하는 베스천 뒤의 호스트에 처음 붙으면 코드를 두 번 넣어야 했다 — TOTP 는 한 번 쓰면 무효하고
// 30초마다 바뀌니 통과할 수 없다. 지금은 코어가 핸드셰이크 도중 키를 보여 주고 신뢰를 받는다.
describe("ensureTrustedHost", () => {
  it("ssh-core 가 붙는 연결은 미리 프로브하지 않는다", async () => {
    const { services, set, probeHost } = setup({
      hosts: [sshHost({ id: "b1" }), sshHost({ id: "t1", jumpHostId: "b1" })],
      knownHosts: [],
    });

    const trusted = await services.ensureTrustedHost(set, {
      hostId: "t1",
      action: sshAction("t1"),
    });

    // 통과시켜 연결을 시작하게 한다 — 모르는 키는 그 연결 안에서 묻는다.
    expect(trusted).toBe(true);
    expect(probeHost).not.toHaveBeenCalled();
  });

  it("이미 신뢰된 호스트도 그대로 통과한다", async () => {
    const { services, set, probeHost } = setup({
      hosts: [sshHost({ id: "t1" })],
      knownHosts: [{ host: "t1.example", port: 22 }],
    });

    await services.ensureTrustedHost(set, {
      hostId: "t1",
      action: sshAction("t1"),
    });

    expect(probeHost).not.toHaveBeenCalled();
  });

  // 키가 바뀐 뒤 복구할 때는 저장된 값과 현재 값을 나란히 보여 줘야 하므로 프로브가 필요하다.
  // 그때는 체인의 홉까지 순서대로 확인한다(점프 경유로 대상 키를 읽어야 하기 때문이다).
  it("forceProbe 는 체인을 순서대로 확인한다", async () => {
    const { services, set, probeHost } = setup({
      hosts: [
        sshHost({ id: "j0" }),
        sshHost({ id: "j1" }),
        sshHost({ id: "t1", jumpHostIds: ["j0", "j1"] }),
      ],
      knownHosts: [],
    });

    await services.ensureTrustedHost(set, {
      hostId: "t1",
      forceProbe: true,
      action: sshAction("t1"),
    });

    expect(probeHost).toHaveBeenCalledTimes(3);
    expect(probeHost).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ hostId: "j0" }),
    );
    expect(probeHost).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ hostId: "j1" }),
    );
    expect(probeHost).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ hostId: "t1" }),
    );
  });

  // VNC 도 통로는 ssh-core 가 연다(ipc/vnc.ts 의 startPortForward) — 그 안에서 물을 수 있다.
  it("VNC 경유 호스트도 미리 프로브하지 않는다", async () => {
    const { services, set, probeHost } = setup({
      hosts: [sshHost({ id: "tunnel" }), vncHost({ id: "v1" })],
      knownHosts: [],
    });

    const trusted = await services.ensureTrustedHost(set, {
      hostId: "tunnel",
      action: { kind: "vnc", hostId: "v1" },
    });

    expect(trusted).toBe(true);
    expect(probeHost).not.toHaveBeenCalled();
  });

  // AWS SSM 은 예외다: 키를 저장하는 이름이 인스턴스 신원(aws-ssm:…)인데 실제로 붙는 주소는 로컬
  // 터널이다. 코어는 자기가 붙은 주소만 아니까 연결 중에 물으면 그 임시 주소로 저장돼 다음
  // 연결에서 또 묻는다. 이 경로는 임시 EIC 키로 인증하므로 미리 읽어도 사람을 두 번 부르지 않는다.
  it("AWS SSM 호스트는 연결 전에 확인한다", async () => {
    const { services, set, probeHost } = setup({
      hosts: [awsHost({ id: "a1" })],
      knownHosts: [],
    });

    await services.ensureTrustedHost(set, {
      hostId: "a1",
      action: sshAction("a1"),
    });

    expect(probeHost).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: "a1" }),
    );
  });

  // 이미 신뢰하고 있으면 그 프로브도 건너뛴다 — 매번 SSM 터널을 여는 비용이 붙는다.
  it("이미 신뢰한 AWS SSM 호스트는 프로브하지 않는다", async () => {
    const { services, set, probeHost } = setup({
      hosts: [awsHost({ id: "a1" })],
      knownHosts: [
        { host: "aws-ssm:default:ap-northeast-2:i-abc", port: 22 },
      ],
    });

    await services.ensureTrustedHost(set, {
      hostId: "a1",
      action: sshAction("a1"),
    });

    expect(probeHost).not.toHaveBeenCalled();
  });
});
