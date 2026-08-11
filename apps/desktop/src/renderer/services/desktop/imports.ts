import type { DesktopApi } from '@shared';
import { desktopApi } from '../desktopApi';

type WarpgateApi = DesktopApi['warpgate'];

export function listAwsProfiles() {
  return desktopApi.aws.listProfiles();
}

export function getSyncStatus() {
  return desktopApi.sync.status();
}

export function previewHostExport(hostIds: string[]) {
  return desktopApi.hostTransfer.previewExport(hostIds);
}

export function exportHostSelection(
  input: Parameters<DesktopApi['hostTransfer']['exportSelection']>[0],
) {
  return desktopApi.hostTransfer.exportSelection(input);
}

export function pickDolgateImportFile() {
  return desktopApi.hostTransfer.pickImportFile();
}

export function probeDolgateImport(filePath: string, password: string) {
  return desktopApi.hostTransfer.probeImport(filePath, password);
}

export function commitDolgateImport(snapshotId: string) {
  return desktopApi.hostTransfer.commitImport(snapshotId);
}

export function discardDolgateImport(snapshotId: string) {
  return desktopApi.hostTransfer.discardImport(snapshotId);
}

export function listExternalAwsProfiles() {
  return desktopApi.aws.listExternalProfiles();
}

export function createAwsProfile(
  input: Parameters<typeof desktopApi.aws.createProfile>[0],
) {
  return desktopApi.aws.createProfile(input);
}

export function prepareAwsSsoProfile(
  input: Parameters<typeof desktopApi.aws.prepareSsoProfile>[0],
) {
  return desktopApi.aws.prepareSsoProfile(input);
}

export function getAwsProfileDetails(profileName: string) {
  return desktopApi.aws.getProfileDetails(profileName);
}

export function getExternalAwsProfileDetails(profileName: string) {
  return desktopApi.aws.getExternalProfileDetails(profileName);
}

export function importExternalAwsProfiles(
  input: Parameters<typeof desktopApi.aws.importExternalProfiles>[0],
) {
  return desktopApi.aws.importExternalProfiles(input);
}

export function updateAwsProfile(
  input: Parameters<typeof desktopApi.aws.updateProfile>[0],
) {
  return desktopApi.aws.updateProfile(input);
}

export function updateAwsProfileRegion(
  input: Parameters<typeof desktopApi.aws.updateProfileRegion>[0],
) {
  return desktopApi.aws.updateProfileRegion(input);
}

export function renameAwsProfile(
  input: Parameters<typeof desktopApi.aws.renameProfile>[0],
) {
  return desktopApi.aws.renameProfile(input);
}

export function deleteAwsProfile(profileName: string) {
  return desktopApi.aws.deleteProfile(profileName);
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

/**
 * Windows 초기 관리자 암호를 가져온다.
 *
 * 개인키는 메인 프로세스로 넘어가 그 자리에서 복호화되고 어디에도 저장되지 않는다 — 렌더러도, AWS 도
 * 개인키를 보관하지 않는다.
 */
export function getAwsWindowsPassword(input: {
  profileName: string;
  region: string;
  instanceId: string;
  privateKeyPem: string;
}) {
  return desktopApi.aws.getWindowsPassword(input);
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
