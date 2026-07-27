import React, { useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useScreenPadding } from '../lib/screen-layout';
import { useMobileAppStore } from '../store/useMobileAppStore';
import { useMobilePalette } from '../theme';
import { getNewVaultPassphraseMessage } from '../i18n/shared-messages';
import { useTranslation } from 'react-i18next';

interface VaultGateShellProps {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  logoutDisabled?: boolean;
}

function VaultGateShell({
  title,
  subtitle,
  children,
  logoutDisabled = false,
}: VaultGateShellProps): React.JSX.Element {
  const { t: translate } = useTranslation();
  const palette = useMobilePalette();
  const screenPadding = useScreenPadding({ topOffset: 24 });
  const logout = useMobileAppStore(state => state.logout);
  const email = useMobileAppStore(
    state => state.auth.session?.user.email ?? null,
  );

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { backgroundColor: palette.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[
          styles.content,
          {
            paddingHorizontal: screenPadding.paddingHorizontal,
            paddingTop: screenPadding.paddingTop,
            paddingBottom: screenPadding.paddingBottom,
          },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={[styles.title, { color: palette.text }]}>{title}</Text>
        {email ? (
          <Text style={[styles.accountText, { color: palette.mutedText }]}>
            {email}
          </Text>
        ) : null}
        <Text style={[styles.subtitle, { color: palette.mutedText }]}>
          {subtitle}
        </Text>

        <View
          style={[
            styles.card,
            {
              backgroundColor: palette.surface,
              borderColor: palette.border,
            },
          ]}
        >
          {children}
        </View>

        <Pressable
          accessibilityRole="button"
          disabled={logoutDisabled}
          onPress={() => void logout()}
          style={[
            styles.logoutButton,
            logoutDisabled ? styles.disabledButton : null,
          ]}
        >
          <Text style={[styles.logoutText, { color: palette.mutedText }]}>
            {translate("vaultGate.switchAccount")}
          </Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

export function VaultSetupScreen(): React.JSX.Element {
  const { t: translate } = useTranslation();
  const palette = useMobilePalette();
  const setupVault = useMobileAppStore(state => state.setupVault);
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const validationMessage = (() => {
    if (!passphrase) {
      return null;
    }
    const passphraseMessage = getNewVaultPassphraseMessage(passphrase);
    if (passphraseMessage) {
      return passphraseMessage;
    }
    if (confirmPassphrase && passphrase !== confirmPassphrase) {
      return translate("vaultGate.mismatch");
    }
    return null;
  })();

  const canSubmit =
    !busy &&
    getNewVaultPassphraseMessage(passphrase) === null &&
    passphrase === confirmPassphrase;

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit) {
      return;
    }
    setBusy(true);
    setErrorMessage(null);
    try {
      await setupVault(passphrase);
      // 성공하면 vault 상태가 unlocked 로 바뀌며 홈으로 전환된다.
    } catch (error) {
      setErrorMessage(
        error instanceof Error && error.message.trim()
          ? error.message
          : translate("vaultGate.setupFailed"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <VaultGateShell
      title={translate("vaultGate.setupTitle")}
      subtitle={translate("vaultGate.setupSubtitle")}
      logoutDisabled={busy}
    >
      <TextInput
        value={passphrase}
        onChangeText={setPassphrase}
        placeholder={translate("vaultGate.passphrasePlaceholder")}
        placeholderTextColor={palette.mutedText}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        style={[
          styles.input,
          {
            color: palette.text,
            borderColor: palette.border,
            backgroundColor: palette.input,
          },
        ]}
      />
      <TextInput
        value={confirmPassphrase}
        onChangeText={setConfirmPassphrase}
        placeholder={translate("vaultGate.confirmPlaceholder")}
        placeholderTextColor={palette.mutedText}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        style={[
          styles.input,
          {
            color: palette.text,
            borderColor: palette.border,
            backgroundColor: palette.input,
          },
        ]}
      />
      {validationMessage ? (
        <Text style={[styles.errorText, { color: palette.warning }]}>
          {validationMessage}
        </Text>
      ) : null}
      {errorMessage ? (
        <Text style={[styles.errorText, { color: palette.danger }]}>
          {errorMessage}
        </Text>
      ) : null}
      <Text style={[styles.noticeText, { color: palette.mutedText }]}>
        {translate("vaultGate.warning")}
      </Text>
      <Pressable
        accessibilityRole="button"
        disabled={!canSubmit}
        onPress={() => void handleSubmit()}
        style={[
          styles.primaryButton,
          {
            backgroundColor: palette.accent,
            opacity: canSubmit ? 1 : 0.55,
          },
        ]}
      >
        <Text style={styles.primaryText}>
          {translate(busy ? "vaultGate.settingUp" : "vaultGate.startSync")}
        </Text>
      </Pressable>
    </VaultGateShell>
  );
}

export function VaultUnlockScreen(): React.JSX.Element {
  const { t: translate } = useTranslation();
  const palette = useMobilePalette();
  const unlockVault = useMobileAppStore(state => state.unlockVault);
  const resetVault = useMobileAppStore(state => state.resetVault);
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const canSubmit = !busy && passphrase.length > 0;

  const handleUnlock = async (): Promise<void> => {
    if (!canSubmit) {
      return;
    }
    setBusy(true);
    setErrorMessage(null);
    try {
      await unlockVault(passphrase);
    } catch (error) {
      setErrorMessage(
        error instanceof Error && error.message.trim()
          ? error.message
          : translate("vaultGate.unlockFailed"),
      );
    } finally {
      setBusy(false);
    }
  };

  const handleReset = async (): Promise<void> => {
    setBusy(true);
    setErrorMessage(null);
    try {
      await resetVault();
      // 성공하면 vault 상태가 setup-required 로 바뀌며 설정 화면으로 전환된다.
    } catch (error) {
      setErrorMessage(
        error instanceof Error && error.message.trim()
          ? error.message
          : translate("vaultGate.resetFailed"),
      );
    } finally {
      setBusy(false);
    }
  };

  const confirmReset = (): void => {
    Alert.alert(
      translate("vaultGate.resetTitle"),
      translate("vaultGate.resetBody"),
      [
        { text: translate("common.cancel"), style: "cancel" },
        {
          text: translate("vaultGate.continue"),
          style: 'destructive',
          onPress: () => {
            Alert.alert(translate("vaultGate.resetFinalTitle"), translate("vaultGate.resetFinalBody"), [
              { text: translate("common.cancel"), style: "cancel" },
              {
                text: translate("vaultGate.resetConfirm"),
                style: 'destructive',
                onPress: () => void handleReset(),
              },
            ]);
          },
        },
      ],
    );
  };

  return (
    <VaultGateShell
      title={translate("vaultGate.unlockTitle")}
      subtitle={translate("vaultGate.unlockSubtitle")}
      logoutDisabled={busy}
    >
      <TextInput
        value={passphrase}
        onChangeText={setPassphrase}
        placeholder={translate("vaultGate.passphrasePlaceholder")}
        placeholderTextColor={palette.mutedText}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        onSubmitEditing={() => void handleUnlock()}
        style={[
          styles.input,
          {
            color: palette.text,
            borderColor: palette.border,
            backgroundColor: palette.input,
          },
        ]}
      />
      {errorMessage ? (
        <Text style={[styles.errorText, { color: palette.danger }]}>
          {errorMessage}
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        disabled={!canSubmit}
        onPress={() => void handleUnlock()}
        style={[
          styles.primaryButton,
          {
            backgroundColor: palette.accent,
            opacity: canSubmit ? 1 : 0.55,
          },
        ]}
      >
        <Text style={styles.primaryText}>
          {translate(busy ? "vaultGate.checking" : "vaultGate.unlock")}
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={confirmReset}
        style={styles.resetButton}
      >
        <Text style={[styles.resetText, { color: palette.danger }]}>
          {translate("vaultGate.forgot")}
        </Text>
      </Pressable>
    </VaultGateShell>
  );
}

// 기존(v1) 유저의 E2EE 전환 프롬프트. 전환해도 데이터는 재암호화 없이 그대로이며,
// "나중에"로 이번 실행 동안 미룰 수 있다(다음 실행 때 다시 뜬다).
export function VaultMigrateScreen(): React.JSX.Element {
  const { t: translate } = useTranslation();
  const palette = useMobilePalette();
  const migrationRequired = useMobileAppStore(
    state => state.vault.status === 'legacy' && state.vault.migrationRequired,
  );
  const migrateVault = useMobileAppStore(state => state.migrateVault);
  const deferVaultMigration = useMobileAppStore(
    state => state.deferVaultMigration,
  );
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const validationMessage = (() => {
    if (!passphrase) {
      return null;
    }
    const passphraseMessage = getNewVaultPassphraseMessage(passphrase);
    if (passphraseMessage) {
      return passphraseMessage;
    }
    if (confirmPassphrase && passphrase !== confirmPassphrase) {
      return translate("vaultGate.mismatch");
    }
    return null;
  })();

  const canSubmit =
    !busy &&
    getNewVaultPassphraseMessage(passphrase) === null &&
    passphrase === confirmPassphrase;

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit) {
      return;
    }
    setBusy(true);
    setErrorMessage(null);
    try {
      await migrateVault(passphrase);
      // 성공하면 vault 상태가 unlocked 로 바뀌며 홈으로 전환된다.
    } catch (error) {
      setErrorMessage(
        error instanceof Error && error.message.trim()
          ? error.message
          : translate("vaultGate.migrateFailed"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <VaultGateShell
      title={translate("vaultGate.setupTitle")}
      subtitle={translate("vaultGate.migrateSubtitle")}
      logoutDisabled={busy}
    >
      <TextInput
        value={passphrase}
        onChangeText={setPassphrase}
        placeholder={translate("vaultGate.passphrasePlaceholder")}
        placeholderTextColor={palette.mutedText}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        style={[
          styles.input,
          {
            color: palette.text,
            borderColor: palette.border,
            backgroundColor: palette.input,
          },
        ]}
      />
      <TextInput
        value={confirmPassphrase}
        onChangeText={setConfirmPassphrase}
        placeholder={translate("vaultGate.confirmPlaceholder")}
        placeholderTextColor={palette.mutedText}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        style={[
          styles.input,
          {
            color: palette.text,
            borderColor: palette.border,
            backgroundColor: palette.input,
          },
        ]}
      />
      {validationMessage ? (
        <Text style={[styles.errorText, { color: palette.warning }]}>
          {validationMessage}
        </Text>
      ) : null}
      {errorMessage ? (
        <Text style={[styles.errorText, { color: palette.danger }]}>
          {errorMessage}
        </Text>
      ) : null}
      <Text style={[styles.noticeText, { color: palette.mutedText }]}>
        {translate("vaultGate.migrateWarning")}
      </Text>
      <Pressable
        accessibilityRole="button"
        disabled={!canSubmit}
        onPress={() => void handleSubmit()}
        style={[
          styles.primaryButton,
          {
            backgroundColor: palette.accent,
            opacity: canSubmit ? 1 : 0.55,
          },
        ]}
      >
        <Text style={styles.primaryText}>
          {translate(busy ? "vaultGate.migrating" : "vaultGate.enableE2ee")}
        </Text>
      </Pressable>
      {!migrationRequired ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={translate("vaultGate.later")}
          disabled={busy}
          onPress={deferVaultMigration}
          style={styles.resetButton}
        >
          <Text style={[styles.resetText, { color: palette.mutedText }]}>
            {translate("vaultGate.later")}
          </Text>
        </Pressable>
      ) : null}
    </VaultGateShell>
  );
}

export function VaultErrorScreen(): React.JSX.Element {
  const { t: translate } = useTranslation();
  const palette = useMobilePalette();
  const errorMessage = useMobileAppStore(state =>
    state.vault.status === 'error' ? state.vault.errorMessage : null,
  );

  return (
    <VaultGateShell
      title={translate("vaultGate.errorTitle")}
      subtitle={translate("vaultGate.errorSubtitle")}
    >
      <Text style={[styles.errorText, { color: palette.danger }]}>
        {errorMessage ??
          translate("vaultGate.restoreFailed")}
      </Text>
    </VaultGateShell>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    gap: 10,
  },
  title: {
    fontSize: 26,
    fontWeight: '900',
  },
  accountText: {
    fontSize: 14,
    fontWeight: '600',
  },
  subtitle: {
    fontSize: 14,
    lineHeight: 21,
    marginBottom: 6,
  },
  card: {
    borderWidth: 1,
    borderRadius: 20,
    padding: 16,
    gap: 12,
  },
  input: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },
  noticeText: {
    fontSize: 12,
    lineHeight: 17,
  },
  errorText: {
    fontSize: 13,
    fontWeight: '700',
  },
  primaryButton: {
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
  },
  primaryText: {
    fontSize: 15,
    fontWeight: '800',
    color: '#F8FBFF',
  },
  resetButton: {
    alignItems: 'center',
    paddingVertical: 6,
  },
  resetText: {
    fontSize: 13,
    fontWeight: '700',
  },
  logoutButton: {
    alignItems: 'center',
    paddingVertical: 12,
  },
  logoutText: {
    fontSize: 13,
    fontWeight: '600',
  },
  disabledButton: {
    opacity: 0.5,
  },
});
