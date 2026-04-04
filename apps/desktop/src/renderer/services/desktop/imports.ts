import type { DesktopApi } from '@shared';
import { desktopApi } from '../desktopApi';

type WarpgateApi = DesktopApi['warpgate'];

export function listAwsProfiles() {
  return desktopApi.aws.listProfiles();
}

export function getAwsProfileStatus(profileName: string) {
  return desktopApi.aws.getProfileStatus(profileName);
}

export function loginAwsProfile(profileName: string) {
  return desktopApi.aws.login(profileName);
}

export function listAwsRegions(profileName: string) {
  return desktopApi.aws.listRegions(profileName);
}

export function listAwsEc2Instances(profileName: string, region: string) {
  return desktopApi.aws.listEc2Instances(profileName, region);
}

export function listAwsEcsClusters(profileName: string, region: string) {
  return desktopApi.aws.listEcsClusters(profileName, region);
}

export function inspectAwsHostSshMetadata(
  input: Parameters<typeof desktopApi.aws.inspectHostSshMetadata>[0],
) {
  return desktopApi.aws.inspectHostSshMetadata(input);
}

export function probeOpenSshDefault() {
  return desktopApi.openssh.probeDefault();
}

export function discardOpenSshSnapshot(snapshotId: string) {
  return desktopApi.openssh.discardSnapshot(snapshotId);
}

export function pickOpenSshConfig() {
  return desktopApi.shell.pickOpenSshConfig();
}

export function addOpenSshFileToSnapshot(
  input: Parameters<typeof desktopApi.openssh.addFileToSnapshot>[0],
) {
  return desktopApi.openssh.addFileToSnapshot(input);
}

export function importOpenSshSelection(
  input: Parameters<typeof desktopApi.openssh.importSelection>[0],
) {
  return desktopApi.openssh.importSelection(input);
}

export function probeTermiusLocal() {
  return desktopApi.termius.probeLocal();
}

export function discardTermiusSnapshot(snapshotId: string) {
  return desktopApi.termius.discardSnapshot(snapshotId);
}

export function importTermiusSelection(
  input: Parameters<typeof desktopApi.termius.importSelection>[0],
) {
  return desktopApi.termius.importSelection(input);
}

export function probeXshellDefault() {
  return desktopApi.xshell.probeDefault();
}

export function discardXshellSnapshot(snapshotId: string) {
  return desktopApi.xshell.discardSnapshot(snapshotId);
}

export function pickXshellSessionFolder() {
  return desktopApi.shell.pickXshellSessionFolder();
}

export function addXshellFolderToSnapshot(
  input: Parameters<typeof desktopApi.xshell.addFolderToSnapshot>[0],
) {
  return desktopApi.xshell.addFolderToSnapshot(input);
}

export function importXshellSelection(
  input: Parameters<typeof desktopApi.xshell.importSelection>[0],
) {
  return desktopApi.xshell.importSelection(input);
}

export function onWarpgateImportEvent(listener: Parameters<WarpgateApi['onImportEvent']>[0]) {
  return desktopApi.warpgate.onImportEvent(listener);
}

export function startWarpgateBrowserImport(baseUrl: string) {
  return desktopApi.warpgate.startBrowserImport(baseUrl);
}

export function cancelWarpgateBrowserImport(attemptId: string) {
  return desktopApi.warpgate.cancelBrowserImport(attemptId);
}
