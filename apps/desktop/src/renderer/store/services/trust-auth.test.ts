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

describe("ensureTrustedHost (jump/bastion pre-trust)", () => {
  it("skips re-probing a bastion that is already trusted, still probing the target", async () => {
    // 베스천 b1은 이미 신뢰(knownHosts에 존재), 타깃 t1은 b1 경유.
    const { services, set, probeHost } = setup({
      hosts: [sshHost({ id: "b1" }), sshHost({ id: "t1", jumpHostId: "b1" })],
      knownHosts: [{ host: "b1.example", port: 22 }],
    });

    await services.ensureTrustedHost(set, {
      hostId: "t1",
      action: sshAction("t1"),
    });

    // 신뢰된 베스천은 재-probe하지 않는다(리셋나던 직접 핸드셰이크 제거) → 타깃만 probe.
    expect(probeHost).toHaveBeenCalledTimes(1);
    expect(probeHost).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: "t1" }),
    );
  });

  it("probes the bastion first when it is not yet trusted", async () => {
    const { services, set, probeHost } = setup({
      hosts: [sshHost({ id: "b1" }), sshHost({ id: "t1", jumpHostId: "b1" })],
      knownHosts: [],
    });

    await services.ensureTrustedHost(set, {
      hostId: "t1",
      action: sshAction("t1"),
    });

    // 미신뢰 베스천은 먼저 probe해 신뢰를 확보한 뒤 타깃을 probe한다.
    expect(probeHost).toHaveBeenCalledTimes(2);
    expect(probeHost).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ hostId: "b1" }),
    );
    expect(probeHost).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ hostId: "t1" }),
    );
  });

  it("probes directly (no pre-trust step) when the host has no jump host", async () => {
    const { services, set, probeHost } = setup({
      hosts: [sshHost({ id: "t1" })],
      knownHosts: [],
    });

    await services.ensureTrustedHost(set, {
      hostId: "t1",
      action: sshAction("t1"),
    });

    expect(probeHost).toHaveBeenCalledTimes(1);
    expect(probeHost).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: "t1" }),
    );
  });

  it("trusts every hop of a multi-hop chain in order before the target", async () => {
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
      action: sshAction("t1"),
    });

    // 첫 홉 j0 → 다음 홉 j1 → 대상 t1 순서로 신뢰(미신뢰 홉마다 probe).
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
});
