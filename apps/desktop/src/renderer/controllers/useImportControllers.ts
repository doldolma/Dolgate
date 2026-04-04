import { useMemo } from 'react';
import {
  addOpenSshFileToSnapshot,
  addXshellFolderToSnapshot,
  cancelWarpgateBrowserImport,
  discardOpenSshSnapshot,
  discardTermiusSnapshot,
  discardXshellSnapshot,
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
  onWarpgateImportEvent,
  pickOpenSshConfig,
  pickXshellSessionFolder,
  probeOpenSshDefault,
  probeTermiusLocal,
  probeXshellDefault,
  startWarpgateBrowserImport,
} from '../services/desktop/imports';

export function useAwsImportController() {
  return useMemo(
    () => ({
      listAwsProfiles,
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
