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
  getAwsProfileDetails,
  getAwsProfileStatus,
  importOpenSshSelection,
  importTermiusSelection,
  importXshellSelection,
  inspectAwsHostSshMetadata,
  listAwsEc2Instances,
  listAwsEcsClusters,
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
      createAwsProfile,
      prepareAwsSsoProfile,
      getAwsProfileStatus,
      loginAwsProfile,
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
      createAwsProfile,
      prepareAwsSsoProfile,
      getAwsProfileDetails,
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
