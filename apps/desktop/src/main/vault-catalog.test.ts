import type { HostRecord } from "@shared";
import { describe, expect, it, vi } from "vitest";
import type { HostRepository, KnownHostRepository, TailnetRepository } from "./database";
import { createVaultCatalog, PERSONAL_VAULT_ID } from "./vault-catalog";

function createHost(id: string, label: string): HostRecord {
  return { id, label, kind: "ssh", hostname: `${label}.example.com`, port: 22 } as HostRecord;
}

function createPersonalRepositories(hosts: HostRecord[]) {
  return {
    hosts: {
      getById: vi.fn((id: string) => hosts.find((host) => host.id === id) ?? null),
      list: vi.fn(() => hosts),
    } as unknown as HostRepository,
    knownHosts: {} as KnownHostRepository,
    tailnets: {} as TailnetRepository,
  };
}

describe("createVaultCatalog", () => {
  it("finds a host in the personal vault and returns null when it is missing", () => {
    const web = createHost("host-1", "web");
    const catalog = createVaultCatalog(createPersonalRepositories([web]));

    expect(catalog.getHost("host-1")).toBe(web);
    expect(catalog.getHost("missing")).toBeNull();
  });

  it("lists hosts in the order the repository returns them", () => {
    const hosts = [createHost("host-b", "b"), createHost("host-a", "a")];
    const catalog = createVaultCatalog(createPersonalRepositories(hosts));

    expect(catalog.listHosts()).toEqual(hosts);
  });

  it("puts every host in the personal vault, including ones it cannot find", () => {
    const repositories = createPersonalRepositories([createHost("host-1", "web")]);
    const catalog = createVaultCatalog(repositories);

    expect(catalog.personal).toEqual({ id: PERSONAL_VAULT_ID, ...repositories });
    expect(catalog.scopeOfHost("host-1")).toBe(catalog.personal);
    expect(catalog.scopeOfHost("missing")).toBe(catalog.personal);
  });
});
