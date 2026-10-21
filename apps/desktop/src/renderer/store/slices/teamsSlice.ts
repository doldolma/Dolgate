import type { SliceDeps } from "../services/context";
import type { TeamsSlice } from "../types";

export function createTeamsSlice(deps: SliceDeps): TeamsSlice {
  const { api, set, get } = deps;
  // 팀 목록이 바뀌는 동작 뒤에는 볼트 표를 곧장 다시 읽는다. 메인이 보내는 workspaceChanged 도 오지만, 그 사이
  // 사이드바·Teams 탭이 옛 팀을 보이지 않게 한다.
  const afterTeamsChanged = () => get().refreshVaultIndex();

  return {
    teamsPanelTeamId: null,
    selectTeamInPanel: (teamId) => set({ teamsPanelTeamId: teamId }),
    showTeamInPanel: (teamId) => {
      set({ teamsPanelTeamId: teamId });
      get().openSettingsSection("teams");
    },
    checkTeamAvailability: async () => {
      const availability = await api.teams.getAvailability().catch(() => null);
      if (!availability) {
        return get().teamAvailability;
      }
      set({ teamAvailability: availability });
      return availability;
    },
    pendingInviteLink: null,
    takePendingInviteLink: async () => {
      const link = await api.teams.takePendingInviteLink().catch(() => null);
      if (link) {
        set({ pendingInviteLink: link });
      }
    },
    openInviteLink: (link) => set({ pendingInviteLink: link.trim() || null }),
    dismissInviteLink: () => set({ pendingInviteLink: null }),
    previewTeamInvite: (link) => api.teams.previewInvite(link),
    joinTeam: async (link) => {
      const team = await api.teams.join(link);
      set({ pendingInviteLink: null, teamsPanelTeamId: team.id });
      await afterTeamsChanged();
      return team;
    },
    createTeam: async (name) => {
      const team = await api.teams.create(name);
      set({ teamsPanelTeamId: team.id });
      await afterTeamsChanged();
      return team;
    },
    renameTeam: async (teamId, name) => {
      await api.teams.rename(teamId, name);
      await afterTeamsChanged();
    },
    deleteTeam: async (teamId) => {
      await api.teams.remove(teamId);
      await afterTeamsChanged();
    },
    leaveTeam: async (teamId, newOwnerId) => {
      try {
        if (newOwnerId) {
          await api.teams.transferOwnership(teamId, newOwnerId);
        }
        await api.teams.leave(teamId);
      } finally {
        // 넘긴 뒤 나가기만 실패해도 내 역할은 이미 멤버다. 표를 맞춰 두어야 다시 누를 때 또 넘기려 하지 않는다.
        await afterTeamsChanged();
      }
    },
    transferTeamOwnership: async (teamId, userId) => {
      await api.teams.transferOwnership(teamId, userId);
      await afterTeamsChanged();
    },
    removeTeamMember: (teamId, userId) => api.teams.removeMember(teamId, userId),
    listTeamMembers: (teamId) => api.teams.listMembers(teamId),
    listTeamInvites: (teamId) => api.teams.listInvites(teamId),
    createTeamInvite: (teamId, expiresInHours) => api.teams.createInvite(teamId, { expiresInHours }),
    revokeTeamInvite: (teamId, code) => api.teams.revokeInvite(teamId, code),
    countTeamSecrets: async (teamId) => (await api.keychain.list(teamId)).length,
    getMyHostCredentials: (hostId) => api.teams.getMyCredentials(hostId),
    saveMyHostCredentials: async (hostId, input) => {
      const summary = await api.teams.setMyCredentials(hostId, input);
      // 내 이름이 카드·팔레트에 바로 — 볼트 표의 내 이름과(이름이 빈 팀 레코드엔) 호스트 목록이 바뀐다.
      await get().refreshHostCatalog();
      return summary;
    },
    clearMyHostCredentials: async (hostId) => {
      await api.teams.clearMyCredentials(hostId);
      await get().refreshHostCatalog();
    },
    previewVaultCopy: (request) => api.teams.previewCopy(request),
    copyToVault: async (request) => {
      const result = await api.teams.copy(request);
      await get().refreshHostCatalog();
      await get().refreshOperationalData();
      return result;
    },
  };
}
