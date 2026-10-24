import { useAppStore } from '../store/appStore';

export function useAppSettingsViewModel() {
  const settings = useAppStore((state) => state.settings);
  const loadSettings = useAppStore((state) => state.loadSettings);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const openSettingsSection = useAppStore((state) => state.openSettingsSection);
  const updateKeychainSecret = useAppStore((state) => state.updateKeychainSecret);
  const cloneKeychainSecretForHost = useAppStore(
    (state) => state.cloneKeychainSecretForHost,
  );
  const generateSshKey = useAppStore((state) => state.generateSshKey);
  const copySshPublicKey = useAppStore((state) => state.copySshPublicKey);
  const installSshPublicKey = useAppStore((state) => state.installSshPublicKey);

  return {
    settings,
    loadSettings,
    updateSettings,
    openSettingsSection,
    updateKeychainSecret,
    cloneKeychainSecretForHost,
    generateSshKey,
    copySshPublicKey,
    installSshPublicKey,
  };
}

export function useSettingsViewModel() {
  const hosts = useAppStore((state) => state.hosts);
  const settings = useAppStore((state) => state.settings);
  const settingsSection = useAppStore((state) => state.settingsSection);
  const savedCredentialsSearchQuery = useAppStore(
    (state) => state.savedCredentialsSearchQuery,
  );
  const knownHosts = useAppStore((state) => state.knownHosts);
  const activityLogs = useAppStore((state) => state.activityLogs);
  const keychainEntries = useAppStore((state) => state.keychainEntries);
  const loadSettings = useAppStore((state) => state.loadSettings);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const openSettingsSection = useAppStore((state) => state.openSettingsSection);
  const setSavedCredentialsSearchQuery = useAppStore(
    (state) => state.setSavedCredentialsSearchQuery,
  );
  const removeKnownHost = useAppStore((state) => state.removeKnownHost);
  const revokeRdpCertificateTrust = useAppStore(
    (state) => state.revokeRdpCertificateTrust,
  );
  const clearLogs = useAppStore((state) => state.clearLogs);
  const removeKeychainSecrets = useAppStore((state) => state.removeKeychainSecrets);
  const updateKeychainSecret = useAppStore((state) => state.updateKeychainSecret);
  const cloneKeychainSecretForHost = useAppStore(
    (state) => state.cloneKeychainSecretForHost,
  );
  const generateSshKey = useAppStore((state) => state.generateSshKey);
  const copySshPublicKey = useAppStore((state) => state.copySshPublicKey);
  const installSshPublicKey = useAppStore((state) => state.installSshPublicKey);
  const loadSessionReplayStorageUsage = useAppStore(
    (state) => state.loadSessionReplayStorageUsage,
  );
  const teamsAvailable = useAppStore((state) => state.teamAvailability.available);

  return {
    hosts,
    settings,
    settingsSection,
    savedCredentialsSearchQuery,
    knownHosts,
    activityLogs,
    keychainEntries,
    loadSettings,
    updateSettings,
    openSettingsSection,
    setSavedCredentialsSearchQuery,
    removeKnownHost,
    revokeRdpCertificateTrust,
    clearLogs,
    removeKeychainSecrets,
    updateKeychainSecret,
    cloneKeychainSecretForHost,
    generateSshKey,
    copySshPublicKey,
    installSshPublicKey,
    loadSessionReplayStorageUsage,
    teamsAvailable,
  };
}
