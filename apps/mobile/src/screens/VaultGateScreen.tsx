import React, { useState } from 'react';
import { validateNewVaultPassphrase } from '@dolssh/shared-core';
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
            다른 계정으로 로그인 (로그아웃)
          </Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

export function VaultSetupScreen(): React.JSX.Element {
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
    const passphraseMessage = validateNewVaultPassphrase(passphrase);
    if (passphraseMessage) {
      return passphraseMessage;
    }
    if (confirmPassphrase && passphrase !== confirmPassphrase) {
      return '두 입력이 일치하지 않습니다.';
    }
    return null;
  })();

  const canSubmit =
    !busy &&
    validateNewVaultPassphrase(passphrase) === null &&
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
          : '동기화 암호 설정에 실패했습니다.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <VaultGateShell
      title="동기화 암호 설정"
      subtitle="종단간 암호화를 위한 동기화 암호를 설정해 주세요. 새 기기에서 로그인할 때 필요합니다."
      logoutDisabled={busy}
    >
      <TextInput
        value={passphrase}
        onChangeText={setPassphrase}
        placeholder="동기화 암호"
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
        placeholder="동기화 암호 확인"
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
        암호를 잊으면 동기화된 데이터를 복구할 수 없습니다. 로그인된 다른 기기가
        있으면 설정에서 변경할 수 있습니다.
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
          {busy ? '설정 중...' : '동기화 시작'}
        </Text>
      </Pressable>
    </VaultGateShell>
  );
}

export function VaultUnlockScreen(): React.JSX.Element {
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
          : '동기화 잠금 해제에 실패했습니다.',
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
          : '볼트 초기화에 실패했습니다.',
      );
    } finally {
      setBusy(false);
    }
  };

  const confirmReset = (): void => {
    Alert.alert(
      '동기화 데이터 초기화',
      '동기화 암호 없이는 서버에 저장된 데이터를 복구할 수 없습니다. 초기화하면 서버의 호스트·자격 증명이 모두 삭제되고 새로 시작합니다.',
      [
        { text: '취소', style: 'cancel' },
        {
          text: '계속',
          style: 'destructive',
          onPress: () => {
            Alert.alert('정말 초기화할까요?', '이 작업은 되돌릴 수 없습니다.', [
              { text: '취소', style: 'cancel' },
              {
                text: '모두 삭제하고 새로 시작',
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
      title="동기화 잠금 해제"
      subtitle="이 계정의 동기화 암호를 입력해 주세요."
      logoutDisabled={busy}
    >
      <TextInput
        value={passphrase}
        onChangeText={setPassphrase}
        placeholder="동기화 암호"
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
          {busy ? '확인 중...' : '잠금 해제'}
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={confirmReset}
        style={styles.resetButton}
      >
        <Text style={[styles.resetText, { color: palette.danger }]}>
          동기화 암호를 잊으셨나요? 데이터 초기화
        </Text>
      </Pressable>
    </VaultGateShell>
  );
}

// 기존(v1) 유저의 E2EE 전환 프롬프트. 전환해도 데이터는 재암호화 없이 그대로이며,
// "나중에"로 이번 실행 동안 미룰 수 있다(다음 실행 때 다시 뜬다).
export function VaultMigrateScreen(): React.JSX.Element {
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
    const passphraseMessage = validateNewVaultPassphrase(passphrase);
    if (passphraseMessage) {
      return passphraseMessage;
    }
    if (confirmPassphrase && passphrase !== confirmPassphrase) {
      return '두 입력이 일치하지 않습니다.';
    }
    return null;
  })();

  const canSubmit =
    !busy &&
    validateNewVaultPassphrase(passphrase) === null &&
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
          : '종단간 암호화 전환에 실패했습니다.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <VaultGateShell
      title="동기화 암호 설정"
      subtitle="종단간 암호화를 위한 동기화 암호를 설정해 주세요. 기존 데이터는 그대로 유지됩니다."
      logoutDisabled={busy}
    >
      <TextInput
        value={passphrase}
        onChangeText={setPassphrase}
        placeholder="동기화 암호"
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
        placeholder="동기화 암호 확인"
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
        새 기기에서 로그인할 때 이 암호가 필요합니다. 암호를 잊으면 동기화된
        데이터를 복구할 수 없습니다.
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
          {busy ? '전환 중...' : '종단간 암호화 켜기'}
        </Text>
      </Pressable>
      {!migrationRequired ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="나중에"
          disabled={busy}
          onPress={deferVaultMigration}
          style={styles.resetButton}
        >
          <Text style={[styles.resetText, { color: palette.mutedText }]}>
            나중에
          </Text>
        </Pressable>
      ) : null}
    </VaultGateShell>
  );
}

export function VaultErrorScreen(): React.JSX.Element {
  const palette = useMobilePalette();
  const errorMessage = useMobileAppStore(state =>
    state.vault.status === 'error' ? state.vault.errorMessage : null,
  );

  return (
    <VaultGateShell
      title="동기화 볼트 오류"
      subtitle="볼트 정보를 안전하게 확인하지 못해 동기화를 중단했습니다."
    >
      <Text style={[styles.errorText, { color: palette.danger }]}>
        {errorMessage ??
          '동기화 볼트 상태를 복원할 수 없습니다. 로그아웃한 뒤 다시 로그인해 주세요.'}
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
