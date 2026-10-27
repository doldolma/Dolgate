import { describe, expect, it } from "vitest";
import {
  canChangeTeamRole,
  canEditTeamVault,
  canManageTeam,
  canRemoveTeamMember,
  normalizeTeamInviteRole,
  normalizeTeamRole,
  teamRoleAtLeast,
  type TeamAssignableRole,
  type TeamRole,
} from "@shared";

// 역할 판단(shared-core/team-roles.ts)은 서버(team_store.go)의 규칙을 그대로 따른다 — 화면은 이것으로 길을 닫고,
// 막는 것은 서버다. 여기서는 표 하나로 두 규칙이 같은지 본다.

const ROLES: TeamRole[] = ["owner", "admin", "member", "viewer"];

describe("team roles", () => {
  it("reads roles from the server or a state file, taking anything unknown as read-only", () => {
    expect(ROLES.map(normalizeTeamRole)).toEqual(ROLES);
    for (const unknown of ["superuser", "", null, undefined, 3, "Owner"]) {
      expect(normalizeTeamRole(unknown)).toBe("viewer");
    }
    expect(normalizeTeamInviteRole("viewer")).toBe("viewer");
    for (const other of ["member", "admin", "owner", undefined, ""]) {
      expect(normalizeTeamInviteRole(other)).toBe("member");
    }
  });

  it("ranks the roles: who edits the vault and who manages the team", () => {
    expect(ROLES.filter(canEditTeamVault)).toEqual(["owner", "admin", "member"]);
    expect(ROLES.filter(canManageTeam)).toEqual(["owner", "admin"]);
    expect(teamRoleAtLeast("admin", "member")).toBe(true);
    expect(teamRoleAtLeast("member", "admin")).toBe(false);
  });

  it("lets the owner remove anyone but themself, and an admin only members and viewers", () => {
    const allowed = ROLES.flatMap((actor) =>
      ROLES.filter((target) => canRemoveTeamMember(actor, target)).map((target) => `${actor}→${target}`),
    );
    expect(allowed).toEqual(["owner→admin", "owner→member", "owner→viewer", "admin→member", "admin→viewer"]);
  });

  it("lets the owner give any role but owner, an admin only member and viewer, and nobody change the owner", () => {
    const assignable: TeamAssignableRole[] = ["admin", "member", "viewer"];
    const allowed = ROLES.flatMap((actor) =>
      ROLES.flatMap((target) =>
        assignable.filter((to) => canChangeTeamRole(actor, target, to)).map((to) => `${actor}:${target}→${to}`),
      ),
    );
    expect(allowed).toEqual([
      "owner:admin→admin",
      "owner:admin→member",
      "owner:admin→viewer",
      "owner:member→admin",
      "owner:member→member",
      "owner:member→viewer",
      "owner:viewer→admin",
      "owner:viewer→member",
      "owner:viewer→viewer",
      "admin:member→member",
      "admin:member→viewer",
      "admin:viewer→member",
      "admin:viewer→viewer",
    ]);
  });
});
