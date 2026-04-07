import { useMemo } from 'react';
import {
  addOpenSshFileToSnapshot,
  addXshellFolderToSnapshot,
  cancelWarpgateBrowserImport,
  createAwsProfile,
  deleteAwsProfile,
  discardOpenSshSnapshot,
  discardTermiusSnapshot,
  discardXshellSnapshot,
  getSyncStatus,
  getExternalAwsProfileDetails,
  getAwsProfileDetails,
  getAwsProfileStatus,
  importExternalAwsProfiles,
  importOpenSshSelection,
  importTermiusSelection,
  importXshellSelection,
  inspectAwsHostSshMetadata,
  listAwsEc2Instances,
  listAwsEcsClusters,
  listExternalAwsProfiles,
  listAwsProfiles,
  listAwsRegions,
  loginAwsProfile,
  prepareAwsSsoProfile,
  onWarpgateImportEvent,
  pickOpenSshConfig,
  pickXshellSessionFolder,
  probeOpenSshDefault,
  probeTermiusLocal,
  probeXshellDefault,
  renameAwsProfile,
  startWarpgateBrowserImport,
  updateAwsProfile,
} from '../services/desktop/imports';

export function useAwsImportController() {
  return useMemo(
    () => ({
      listAwsProfiles,
      getSyncStatus,
      listExternalAwsProfiles,
      createAwsProfile,
      prepareAwsSsoProfile,
      getAwsProfileStatus,
      loginAwsProfile,
      getExternalAwsProfileDetails,
      importExternalAwsProfiles,
      listAwsRegions,
      listAwsEc2Instances,
      listAwsEcsClusters,
      inspectAwsHostSshMetadata,
    }),
    [],
  );
}

export function useOpenSshImportController() {
  return useMemo(
    () => ({
      probeOpenSshDefault,
      discardOpenSshSnapshot,
      pickOpenSshConfig,
      addOpenSshFileToSnapshot,
      importOpenSshSelection,
    }),
    [],
  );
}

export function useAwsProfilesController() {
  return useMemo(
    () => ({
      listAwsProfiles,
      getSyncStatus,
      listExternalAwsProfiles,
      createAwsProfile,
      prepareAwsSsoProfile,
      getAwsProfileDetails,
      getExternalAwsProfileDetails,
      importExternalAwsProfiles,
      updateAwsProfile,
      renameAwsProfile,
      deleteAwsProfile,
      loginAwsProfile,
    }),
    [],
  );
}

export function useTermiusImportController() {
  return useMemo(
    () => ({
      probeTermiusLocal,
      discardTermiusSnapshot,
      importTermiusSelection,
    }),
    [],
  );
}

export function useXshellImportController() {
  return useMemo(
    () => ({
      probeXshellDefault,
      discardXshellSnapshot,
      pickXshellSessionFolder,
      addXshellFolderToSnapshot,
      importXshellSelection,
    }),
    [],
  );
}

export function useWarpgateImportController() {
  return useMemo(
    () => ({
      onWarpgateImportEvent,
      startWarpgateBrowserImport,
      cancelWarpgateBrowserImport,
    }),
    [],
  );
}
