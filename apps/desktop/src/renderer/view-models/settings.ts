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

  return {
    settings,
    loadSettings,
    updateSettings,
    openSettingsSection,
    updateKeychainSecret,
    cloneKeychainSecretForHost,
  };
}

export function useSettingsViewModel() {
  const hosts = useAppStore((state) => state.hosts);
  const settings = useAppStore((state) => state.settings);
  const settingsSection = useAppStore((state) => state.settingsSection);
  const knownHosts = useAppStore((state) => state.knownHosts);
  const activityLogs = useAppStore((state) => state.activityLogs);
  const keychainEntries = useAppStore((state) => state.keychainEntries);
  const loadSettings = useAppStore((state) => state.loadSettings);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const openSettingsSection = useAppStore((state) => state.openSettingsSection);
  const removeKnownHost = useAppStore((state) => state.removeKnownHost);
  const clearLogs = useAppStore((state) => state.clearLogs);
  const removeKeychainSecret = useAppStore((state) => state.removeKeychainSecret);
  const updateKeychainSecret = useAppStore((state) => state.updateKeychainSecret);
  const cloneKeychainSecretForHost = useAppStore(
    (state) => state.cloneKeychainSecretForHost,
  );

  return {
    hosts,
    settings,
    settingsSection,
    knownHosts,
    activityLogs,
    keychainEntries,
    loadSettings,
    updateSettings,
    openSettingsSection,
    removeKnownHost,
    clearLogs,
    removeKeychainSecret,
    updateKeychainSecret,
    cloneKeychainSecretForHost,
  };
}
