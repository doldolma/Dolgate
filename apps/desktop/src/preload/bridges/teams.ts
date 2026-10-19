import type { IpcRenderer } from "electron";
import type { DesktopApi } from "@shared";
import { ipcChannels } from "../../common/ipc-channels";
import { subscribeTeamsChanged } from "../events/state";

export function buildTeamsBridge(ipcRenderer: IpcRenderer): DesktopApi["teams"] {
  return {
    list: () => ipcRenderer.invoke(ipcChannels.teams.list),
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
    join: (link) => ipcRenderer.invoke(ipcChannels.teams.join, link),
    onChanged: (listener) => subscribeTeamsChanged(listener),
  };
}
