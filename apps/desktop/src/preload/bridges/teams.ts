import type { IpcRenderer } from "electron";
import type { DesktopApi } from "@shared";
import { ipcChannels } from "../../common/ipc-channels";
import { subscribeTeamInviteLink, subscribeTeamsChanged } from "../events/state";

export function buildTeamsBridge(ipcRenderer: IpcRenderer): DesktopApi["teams"] {
  return {
    list: () => ipcRenderer.invoke(ipcChannels.teams.list),
    getAvailability: () => ipcRenderer.invoke(ipcChannels.teams.getAvailability),
    getVaultIndex: () => ipcRenderer.invoke(ipcChannels.teams.getVaultIndex),
    refresh: () => ipcRenderer.invoke(ipcChannels.teams.refresh),
    create: (name) => ipcRenderer.invoke(ipcChannels.teams.create, name),
    rename: (teamId, name) => ipcRenderer.invoke(ipcChannels.teams.rename, teamId, name),
    remove: (teamId) => ipcRenderer.invoke(ipcChannels.teams.remove, teamId),
    transferOwnership: (teamId, userId) =>
      ipcRenderer.invoke(ipcChannels.teams.transferOwnership, teamId, userId),
    listMembers: (teamId) => ipcRenderer.invoke(ipcChannels.teams.listMembers, teamId),
    removeMember: (teamId, userId) => ipcRenderer.invoke(ipcChannels.teams.removeMember, teamId, userId),
    leave: (teamId) => ipcRenderer.invoke(ipcChannels.teams.leave, teamId),
    createInvite: (teamId, options) => ipcRenderer.invoke(ipcChannels.teams.createInvite, teamId, options),
    listInvites: (teamId) => ipcRenderer.invoke(ipcChannels.teams.listInvites, teamId),
    revokeInvite: (teamId, code) => ipcRenderer.invoke(ipcChannels.teams.revokeInvite, teamId, code),
    getInviteInfo: (link) => ipcRenderer.invoke(ipcChannels.teams.getInviteInfo, link),
    previewInvite: (link) => ipcRenderer.invoke(ipcChannels.teams.previewInvite, link),
    takePendingInviteLink: () => ipcRenderer.invoke(ipcChannels.teams.takePendingInviteLink),
    join: (link) => ipcRenderer.invoke(ipcChannels.teams.join, link),
    previewCopy: (request) => ipcRenderer.invoke(ipcChannels.teams.previewCopy, request),
    copy: (request) => ipcRenderer.invoke(ipcChannels.teams.copy, request),
    getMyCredentials: (hostId) => ipcRenderer.invoke(ipcChannels.teams.getMyCredentials, hostId),
    setMyCredentials: (hostId, credentials) =>
      ipcRenderer.invoke(ipcChannels.teams.setMyCredentials, hostId, credentials),
    clearMyCredentials: (hostId) => ipcRenderer.invoke(ipcChannels.teams.clearMyCredentials, hostId),
    listActivity: (teamId, query) => ipcRenderer.invoke(ipcChannels.teams.listActivity, teamId, query),
    getReplayStatuses: (teamId, recordingIds) =>
      ipcRenderer.invoke(ipcChannels.teams.getReplayStatuses, teamId, recordingIds),
    onChanged: (listener) => subscribeTeamsChanged(listener),
    onInviteLink: (listener) => subscribeTeamInviteLink(listener),
  };
}
