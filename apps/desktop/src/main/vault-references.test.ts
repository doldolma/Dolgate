import { describe, expect, it } from "vitest";
import type { HostDraft, HostRecord } from "@shared";
import { findCrossVaultReference, listHostReferences } from "./vault-references";
import type { VaultScope } from "./vault-catalog";

// 볼트는 완전히 나뉜다 — 호스트가 다른 볼트의 레코드를 가리키면 저장하지 않는다. 다만 어디에도 없는(지워진) 참조와
// 고치기 전과 같은 참조는 그대로 둔다(옛 레코드를 고칠 때 저장을 막지 않게).

function scope(id: string, ids: { host?: string; tailnet?: string; aws?: string; snippet?: string; secret?: string }) {
  return {
    id,
    hosts: { getById: (value: string) => (value === ids.host ? { id: value } : null) },
    tailnets: { list: () => (ids.tailnet ? [{ id: ids.tailnet }] : []) },
    awsProfiles: { getMetadataById: (value: string) => (value === ids.aws ? { id: value } : null) },
    snippets: { getById: (value: string) => (value === ids.snippet ? { id: value } : null) },
    secretMetadata: { getBySecretRef: (value: string) => (value === ids.secret ? { secretRef: value } : null) },
  } as unknown as VaultScope;
}

const personal = scope("personal", { host: "my-jump", tailnet: "my-tailnet", aws: "my-aws", snippet: "my-snippet", secret: "secret:mine" });
const team = scope("team-1", { host: "team-jump", tailnet: "team-tailnet", aws: "team-aws", snippet: "team-snippet", secret: "secret:team" });
// 볼트 카탈로그처럼 — 호스트는 모든 볼트에서 찾고, 팀에서 찾으면 그 팀, 아니면 개인이다.
const scopes = [personal, team];
const vaults = {
  listScopes: () => scopes,
  getHost: (id: string) => scopes.map((scope) => scope.hosts.getById(id)).find(Boolean) ?? null,
  scopeOfHost: (id: string) => scopes.find((scope) => scope.id !== "personal" && scope.hosts.getById(id)) ?? personal,
} as never;

const ssh = (overrides: Record<string, unknown> = {}) =>
  ({ kind: "ssh", label: "h", hostname: "h", port: 22, username: "u", authType: "password", ...overrides }) as unknown as HostDraft;

describe("listHostReferences", () => {
  it("collects every field that points at another record", () => {
    expect(
      listHostReferences(
        ssh({
          jumpHostIds: ["a", " b "],
          jumpHostId: "a",
          tailnetId: "t",
          secretRef: "secret:s",
          startupCommand: { type: "snippet", snippetId: "sn" },
        }),
      ),
    ).toEqual([
      { kind: "jumpHost", id: "a" },
      { kind: "jumpHost", id: "b" },
      { kind: "jumpHost", id: "a" },
      { kind: "tailnet", id: "t" },
      { kind: "snippet", id: "sn" },
      { kind: "secret", id: "secret:s" },
    ]);
    expect(listHostReferences({ kind: "vnc", sshTunnelHostId: "tun" } as never)).toEqual([{ kind: "tunnelHost", id: "tun" }]);
    expect(listHostReferences({ kind: "aws-ec2", awsProfileId: "p" } as never)).toEqual([{ kind: "awsProfile", id: "p" }]);
    // 명령으로 시작하는 것·빈 값은 참조가 아니다.
    expect(listHostReferences(ssh({ startupCommand: { type: "command", command: "ls" }, tailnetId: " ", jumpHostIds: [null] }))).toEqual([]);
  });
});

describe("findCrossVaultReference", () => {
  it("refuses each kind of reference into another vault", () => {
    expect(findCrossVaultReference(vaults, team, ssh({ jumpHostIds: ["team-jump", "my-jump"] }))).toEqual({ kind: "jumpHost", id: "my-jump" });
    expect(findCrossVaultReference(vaults, team, { kind: "vnc", sshTunnelHostId: "my-jump" } as never)).toEqual({ kind: "tunnelHost", id: "my-jump" });
    expect(findCrossVaultReference(vaults, team, ssh({ tailnetId: "my-tailnet" }))).toEqual({ kind: "tailnet", id: "my-tailnet" });
    expect(findCrossVaultReference(vaults, team, { kind: "aws-ec2", awsProfileId: "my-aws" } as never)).toEqual({ kind: "awsProfile", id: "my-aws" });
    expect(findCrossVaultReference(vaults, team, ssh({ startupCommand: { type: "snippet", snippetId: "my-snippet" } }))).toEqual({
      kind: "snippet",
      id: "my-snippet",
    });
    // 개인 호스트가 팀 자격 증명을 거는 것도.
    expect(findCrossVaultReference(vaults, personal, ssh({ secretRef: "secret:team" }))).toEqual({ kind: "secret", id: "secret:team" });
  });

  it("lets same-vault, missing and unchanged references through", () => {
    expect(
      findCrossVaultReference(
        vaults,
        team,
        ssh({ jumpHostIds: ["team-jump"], tailnetId: "team-tailnet", secretRef: "secret:team", startupCommand: { type: "snippet", snippetId: "team-snippet" } }),
      ),
    ).toBeNull();
    // 어디에도 없는 것(지워진 tailnet 등)은 막지 않는다 — 화면이 "이 기기에 없음" 으로 보인다.
    expect(findCrossVaultReference(vaults, team, ssh({ tailnetId: "gone", jumpHostIds: ["gone-host"] }))).toBeNull();
    // 고치기 전부터 가리키던 것은 그대로 둔다(옛 레코드의 다른 칸을 고칠 때).
    const current = ssh({ tailnetId: "my-tailnet" }) as unknown as HostRecord;
    expect(findCrossVaultReference(vaults, team, ssh({ tailnetId: "my-tailnet", label: "renamed" }), current)).toBeNull();
    // 새로 바꾸면 막는다.
    expect(findCrossVaultReference(vaults, team, ssh({ tailnetId: "my-tailnet", jumpHostIds: ["my-jump"] }), current)).toEqual({
      kind: "jumpHost",
      id: "my-jump",
    });
  });

  it("checks nothing without teams — there is no other vault to cross into", () => {
    expect(
      findCrossVaultReference({ listScopes: () => [personal], getHost: () => null, scopeOfHost: () => personal } as never, personal, ssh({ secretRef: "secret:team", tailnetId: "x" })),
    ).toBeNull();
  });
});
