import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  validateAccountPassword,
  validateNewVaultPassphrase,
} from "@dolssh/shared-core";
import { useNavigation } from "@react-navigation/native";
import type { NavigationProp } from "@react-navigation/native";
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { APP_VERSION } from "../lib/app-metadata";
import { IosEdgeSwipeBack } from "../components/IosEdgeSwipeBack";
import {
  DEFAULT_SERVER_URL,
  getSettingsValidationMessage,
} from "../lib/mobile";
import type { MainTabParamList } from "../navigation/RootNavigator";
import { useScreenPadding } from "../lib/screen-layout";
import { useMobileAppStore } from "../store/useMobileAppStore";
import { useMobilePalette } from "../theme";

interface SettingsContentProps {
  mode: "auth" | "full";
  onServerUrlSaved?: () => void;
}

function SettingsContent({
  mode,
  onServerUrlSaved,
}: SettingsContentProps): React.JSX.Element {
  const palette = useMobilePalette();
  const screenPadding = useScreenPadding({
    includeSafeTop: mode !== "auth",
    topOffset: mode === "auth" ? 14 : 10,
  });
  const auth = useMobileAppStore((state) => state.auth);
  const vault = useMobileAppStore((state) => state.vault);
  const settings = useMobileAppStore((state) => state.settings);
  const syncStatus = useMobileAppStore((state) => state.syncStatus);
  const knownHosts = useMobileAppStore((state) => state.knownHosts);
  const secretMetadata = useMobileAppStore((state) => state.secretMetadata);
  const logout = useMobileAppStore((state) => state.logout);
  const deleteAccount = useMobileAppStore((state) => state.deleteAccount);
  const changeAccountPassword = useMobileAppStore(
    (state) => state.changeAccountPassword,
  );
  const changeVaultPassphrase = useMobileAppStore(
    (state) => state.changeVaultPassphrase,
  );
  const updateSettings = useMobileAppStore((state) => state.updateSettings);

  const [serverUrlDraft, setServerUrlDraft] = useState(settings.serverUrl);
  const [savingServerUrl, setSavingServerUrl] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [accountPasswordOpen, setAccountPasswordOpen] = useState(false);
  const [currentAccountPasswordDraft, setCurrentAccountPasswordDraft] =
    useState("");
  const [nextAccountPasswordDraft, setNextAccountPasswordDraft] = useState("");
  const [confirmAccountPasswordDraft, setConfirmAccountPasswordDraft] =
    useState("");
  const [changingAccountPassword, setChangingAccountPassword] = useState(false);
  const [changePassphraseOpen, setChangePassphraseOpen] = useState(false);
  const [currentPassphraseDraft, setCurrentPassphraseDraft] = useState("");
  const [nextPassphraseDraft, setNextPassphraseDraft] = useState("");
  const [confirmPassphraseDraft, setConfirmPassphraseDraft] = useState("");
  const [changingPassphrase, setChangingPassphrase] = useState(false);

  useEffect(() => {
    setServerUrlDraft(settings.serverUrl);
  }, [settings.serverUrl]);

  const accountPasswordState =
    auth.status === "authenticated"
      ? auth.session?.user.passwordState
      : undefined;

  useEffect(() => {
    if (
      accountPasswordState === "set" ||
      accountPasswordState === "unset"
    ) {
      return;
    }
    setAccountPasswordOpen(false);
    setCurrentAccountPasswordDraft("");
    setNextAccountPasswordDraft("");
    setConfirmAccountPasswordDraft("");
  }, [accountPasswordState]);

  useEffect(() => {
    if (vault.status === "unlocked") {
      return;
    }
    setChangePassphraseOpen(false);
    setCurrentPassphraseDraft("");
    setNextPassphraseDraft("");
    setConfirmPassphraseDraft("");
  }, [vault.status]);

  const validationMessage = useMemo(
    () => getSettingsValidationMessage(serverUrlDraft),
    [serverUrlDraft],
  );

  const hasAuthenticatedSession =
    (auth.status === "authenticated" ||
      auth.status === "offline-authenticated") &&
    Boolean(auth.session);
  const showFullSettings = mode === "full" && hasAuthenticatedSession;
  const showSyncStatus = syncStatus.status !== "syncing";
  const canSaveServerUrl = !validationMessage && !savingServerUrl;

  const handleSaveServerUrl = async (): Promise<void> => {
    if (!canSaveServerUrl) {
      return;
    }

    let saved = false;
    setSavingServerUrl(true);
    try {
      await updateSettings({ serverUrl: serverUrlDraft });
      saved = true;
    } finally {
      setSavingServerUrl(false);
    }

    if (saved) {
      onServerUrlSaved?.();
    }
  };

  const handleDeleteAccount = async (): Promise<void> => {
    setDeletingAccount(true);
    try {
      await deleteAccount();
      // 성공하면 auth가 unauthenticated로 바뀌며 로그인 화면으로 전환된다.
    } catch (error) {
      Alert.alert(
        "회원 탈퇴 실패",
        error instanceof Error && error.message.trim()
          ? error.message
          : "회원 탈퇴에 실패했습니다.",
      );
    } finally {
      setDeletingAccount(false);
    }
  };

  const nextAccountPasswordValidationMessage = nextAccountPasswordDraft
    ? validateAccountPassword(nextAccountPasswordDraft)
    : null;
  const canChangeAccountPassword =
    !changingAccountPassword &&
    (accountPasswordState === "unset" || accountPasswordState === "set") &&
    (accountPasswordState === "unset" ||
      currentAccountPasswordDraft.length > 0) &&
    validateAccountPassword(nextAccountPasswordDraft) === null &&
    nextAccountPasswordDraft === confirmAccountPasswordDraft;

  const resetAccountPasswordForm = (): void => {
    setCurrentAccountPasswordDraft("");
    setNextAccountPasswordDraft("");
    setConfirmAccountPasswordDraft("");
  };

  const openAccountPassword = (): void => {
    resetAccountPasswordForm();
    setAccountPasswordOpen(true);
  };

  const closeAccountPassword = (): void => {
    if (changingAccountPassword) {
      return;
    }
    resetAccountPasswordForm();
    setAccountPasswordOpen(false);
  };

  const handleChangeAccountPassword = async (): Promise<void> => {
    if (!canChangeAccountPassword) {
      return;
    }
    const isChanging = accountPasswordState === "set";
    setChangingAccountPassword(true);
    try {
      await changeAccountPassword(
        isChanging ? currentAccountPasswordDraft : "",
        nextAccountPasswordDraft,
      );
      resetAccountPasswordForm();
      setAccountPasswordOpen(false);
      Alert.alert(
        isChanging
          ? "로그인 비밀번호 변경 완료"
          : "로그인 비밀번호 설정 완료",
      );
    } catch (error) {
      Alert.alert(
        isChanging
          ? "로그인 비밀번호 변경 실패"
          : "로그인 비밀번호 설정 실패",
        error instanceof Error && error.message.trim()
          ? error.message
          : "로그인 비밀번호를 저장하지 못했습니다.",
      );
    } finally {
      setChangingAccountPassword(false);
    }
  };

  const canChangePassphrase =
    !changingPassphrase &&
    currentPassphraseDraft.length > 0 &&
    validateNewVaultPassphrase(nextPassphraseDraft) === null &&
    nextPassphraseDraft === confirmPassphraseDraft;
  const nextPassphraseValidationMessage = nextPassphraseDraft
    ? validateNewVaultPassphrase(nextPassphraseDraft)
    : null;

  const handleChangePassphrase = async (): Promise<void> => {
    if (!canChangePassphrase) {
      return;
    }
    setChangingPassphrase(true);
    try {
      await changeVaultPassphrase(currentPassphraseDraft, nextPassphraseDraft);
      setCurrentPassphraseDraft("");
      setNextPassphraseDraft("");
      setConfirmPassphraseDraft("");
      setChangePassphraseOpen(false);
      Alert.alert("동기화 암호 변경 완료");
    } catch (error) {
      Alert.alert(
        "동기화 암호 변경 실패",
        error instanceof Error && error.message.trim()
          ? error.message
          : "동기화 암호 변경에 실패했습니다.",
      );
    } finally {
      setChangingPassphrase(false);
    }
  };

  const openChangePassphrase = (): void => {
    setCurrentPassphraseDraft("");
    setNextPassphraseDraft("");
    setConfirmPassphraseDraft("");
    setChangePassphraseOpen(true);
  };

  const closeChangePassphrase = (): void => {
    if (changingPassphrase) {
      return;
    }
    setCurrentPassphraseDraft("");
    setNextPassphraseDraft("");
    setConfirmPassphraseDraft("");
    setChangePassphraseOpen(false);
  };

  const confirmDeleteAccount = (): void => {
    Alert.alert(
      "회원 탈퇴",
      "서버에 저장된 모든 데이터(동기화된 호스트·시크릿·계정 정보)가 즉시 영구 삭제됩니다. 복구할 수 없으며, 로그인된 다른 기기도 곧 로그아웃됩니다.",
      [
        { text: "취소", style: "cancel" },
        {
          text: "계속",
          style: "destructive",
          onPress: () => {
            Alert.alert(
              "정말 탈퇴할까요?",
              "이 기기의 로컬 데이터(호스트·자격 증명)도 함께 삭제됩니다. 이 작업은 되돌릴 수 없습니다.",
              [
                { text: "취소", style: "cancel" },
                {
                  text: "영구 삭제",
                  style: "destructive",
                  onPress: () => void handleDeleteAccount(),
                },
              ],
            );
          },
        },
      ],
    );
  };

  return (
    <ScrollView
      style={[
        styles.screen,
        {
          backgroundColor: palette.background,
        },
      ]}
      contentContainerStyle={[
        styles.content,
        {
          paddingHorizontal: screenPadding.paddingHorizontal,
          paddingTop: screenPadding.paddingTop,
          paddingBottom: screenPadding.paddingBottom,
        },
      ]}
    >
      {mode === "full" ? (
        <Text style={[styles.title, { color: palette.text }]}>Settings</Text>
      ) : null}

      {showFullSettings ? (
        <View
          style={[
            styles.section,
            {
              backgroundColor: palette.surface,
              borderColor: palette.border,
            },
          ]}
        >
          <Text style={[styles.sectionTitle, { color: palette.text }]}>
            Account
          </Text>
          <Text style={[styles.body, { color: palette.mutedText }]}>
            {auth.session?.user.email ?? "로그인되지 않음"}
          </Text>
          <Text style={[styles.body, { color: palette.mutedText }]}>
            인증 상태: {auth.status}
          </Text>
          {showSyncStatus ? (
            <Text style={[styles.body, { color: palette.mutedText }]}>
              동기화 상태: {syncStatus.status}
            </Text>
          ) : null}
          {auth.status === "offline-authenticated" ? (
            <Text style={[styles.infoText, { color: palette.warning }]}>
              오프라인 캐시로 사용 중입니다.
            </Text>
          ) : null}
          {auth.errorMessage ? (
            <Text style={[styles.errorText, { color: palette.danger }]}>
              {auth.errorMessage}
            </Text>
          ) : null}
          {!auth.errorMessage && syncStatus.errorMessage ? (
            <Text style={[styles.errorText, { color: palette.danger }]}>
              {syncStatus.errorMessage}
            </Text>
          ) : null}
          <View style={styles.row}>
            {accountPasswordState === "set" ||
            accountPasswordState === "unset" ? (
              <Pressable
                onPress={openAccountPassword}
                style={[
                  styles.secondaryButton,
                  {
                    backgroundColor: palette.surfaceAlt,
                    borderColor: palette.border,
                  },
                ]}
              >
                <Text style={[styles.secondaryText, { color: palette.text }]}>
                  {accountPasswordState === "set"
                    ? "비밀번호 변경"
                    : "비밀번호 설정"}
                </Text>
              </Pressable>
            ) : null}
            <Pressable
              onPress={() => void logout()}
              style={[
                styles.secondaryButton,
                {
                  backgroundColor: palette.surfaceAlt,
                  borderColor: palette.border,
                },
              ]}
            >
              <Text style={[styles.secondaryText, { color: palette.text }]}>
                로그아웃
              </Text>
            </Pressable>
            {auth.status === "authenticated" ? (
              <Pressable
                disabled={deletingAccount}
                onPress={confirmDeleteAccount}
                style={[
                  styles.secondaryButton,
                  {
                    backgroundColor: palette.surfaceAlt,
                    borderColor: palette.border,
                    opacity: deletingAccount ? 0.55 : 1,
                  },
                ]}
              >
                <Text
                  style={[styles.secondaryText, { color: palette.danger }]}
                >
                  {deletingAccount ? "탈퇴 중..." : "회원 탈퇴"}
                </Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}

      {showFullSettings && vault.status === "unlocked" ? (
        <View
          style={[
            styles.section,
            {
              backgroundColor: palette.surface,
              borderColor: palette.border,
            },
          ]}
        >
          <Text style={[styles.sectionTitle, { color: palette.text }]}>
            동기화 암호
          </Text>
          <Text style={[styles.body, { color: palette.mutedText }]}>
            동기화 암호가 설정되어 있습니다. 잊지 않도록 안전하게 보관해 주세요.
          </Text>
          <Pressable
            onPress={openChangePassphrase}
            style={[
              styles.secondaryButton,
              {
                backgroundColor: palette.surfaceAlt,
                borderColor: palette.border,
                alignSelf: "flex-start",
              },
            ]}
          >
            <Text style={[styles.secondaryText, { color: palette.text }]}>
              암호 변경
            </Text>
          </Pressable>
        </View>
      ) : null}

      <View
        style={[
          styles.section,
          {
            backgroundColor: palette.surface,
            borderColor: palette.border,
          },
        ]}
      >
        <Text style={[styles.sectionTitle, { color: palette.text }]}>
          Server
        </Text>
        <TextInput
          value={serverUrlDraft}
          onChangeText={setServerUrlDraft}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="https://ssh.doldolma.com"
          placeholderTextColor={palette.mutedText}
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
          <Text style={[styles.errorText, { color: palette.danger }]}>
            {validationMessage}
          </Text>
        ) : null}
        <View style={styles.row}>
          <Pressable
            disabled={!canSaveServerUrl}
            onPress={() => void handleSaveServerUrl()}
            style={[
              styles.secondaryButton,
              {
                backgroundColor: palette.surfaceAlt,
                borderColor: palette.border,
                opacity: canSaveServerUrl ? 1 : 0.55,
              },
            ]}
          >
            <Text style={[styles.secondaryText, { color: palette.text }]}>
              저장
            </Text>
          </Pressable>
          <Pressable
            onPress={() => {
              setServerUrlDraft(DEFAULT_SERVER_URL);
              void updateSettings({ serverUrl: DEFAULT_SERVER_URL });
            }}
            style={[
              styles.secondaryButton,
              {
                backgroundColor: palette.surfaceAlt,
                borderColor: palette.border,
              },
            ]}
          >
            <Text style={[styles.secondaryText, { color: palette.text }]}>
              기본값 복원
            </Text>
          </Pressable>
        </View>
      </View>

      {showFullSettings ? (
        <View
          style={[
            styles.section,
            {
              backgroundColor: palette.surface,
              borderColor: palette.border,
            },
          ]}
        >
          <Text style={[styles.sectionTitle, { color: palette.text }]}>
            Known hosts ({knownHosts.length})
          </Text>
          {knownHosts.length === 0 ? (
            <Text style={[styles.body, { color: palette.mutedText }]}>
              아직 신뢰된 호스트 키가 없습니다.
            </Text>
          ) : (
            knownHosts.slice(0, 8).map((record) => (
              <View key={record.id} style={styles.listItem}>
                <Text style={[styles.listTitle, { color: palette.text }]}>
                  {record.host}:{record.port}
                </Text>
                <Text style={[styles.listBody, { color: palette.mutedText }]}>
                  {record.algorithm}
                </Text>
              </View>
            ))
          )}
        </View>
      ) : null}

      {showFullSettings ? (
        <View
          style={[
            styles.section,
            {
              backgroundColor: palette.surface,
              borderColor: palette.border,
            },
          ]}
        >
          <Text style={[styles.sectionTitle, { color: palette.text }]}>
            Stored credentials ({secretMetadata.length})
          </Text>
          {secretMetadata.length === 0 ? (
            <Text style={[styles.body, { color: palette.mutedText }]}>
              아직 저장된 자격 증명이 없습니다.
            </Text>
          ) : (
            secretMetadata.slice(0, 8).map((record) => (
              <View key={record.secretRef} style={styles.listItem}>
                <Text style={[styles.listTitle, { color: palette.text }]}>
                  {record.label}
                </Text>
                <Text style={[styles.listBody, { color: palette.mutedText }]}>
                  {record.hasPassword ? "password " : ""}
                  {record.hasManagedPrivateKey ? "private-key " : ""}
                  {record.hasPassphrase ? "passphrase " : ""}
                  • host {record.linkedHostCount}
                </Text>
              </View>
            ))
          )}
        </View>
      ) : null}

      <View
        style={[
          styles.section,
          {
            backgroundColor: palette.surface,
            borderColor: palette.border,
          },
        ]}
      >
        <Text style={[styles.sectionTitle, { color: palette.text }]}>
          App
        </Text>
        <Text style={[styles.body, { color: palette.mutedText }]}>
          Version {APP_VERSION}
        </Text>
      </View>
      {accountPasswordOpen &&
      showFullSettings &&
      (accountPasswordState === "set" || accountPasswordState === "unset") ? (
        <Modal
          animationType="fade"
          transparent
          visible
          onRequestClose={closeAccountPassword}
        >
          <KeyboardAvoidingView
            style={[styles.modalOverlay, { backgroundColor: palette.overlay }]}
            behavior={Platform.OS === "ios" ? "padding" : "height"}
          >
            <ScrollView
              contentContainerStyle={styles.modalScrollContent}
              keyboardShouldPersistTaps="handled"
            >
              <View
                style={[
                  styles.modalCard,
                  {
                    backgroundColor: palette.surface,
                    borderColor: palette.border,
                  },
                ]}
              >
                <View style={styles.modalHeader}>
                  <Text style={[styles.modalTitle, { color: palette.text }]}>
                    로그인 비밀번호 {accountPasswordState === "set" ? "변경" : "설정"}
                  </Text>
                  <Text style={[styles.body, { color: palette.mutedText }]}>
                    이메일 로그인에 사용하는 비밀번호입니다. 동기화 암호와는 별개입니다.
                  </Text>
                </View>
                {accountPasswordState === "set" ? (
                  <TextInput
                    value={currentAccountPasswordDraft}
                    onChangeText={setCurrentAccountPasswordDraft}
                    placeholder="현재 로그인 비밀번호"
                    placeholderTextColor={palette.mutedText}
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                    textContentType="password"
                    autoComplete="current-password"
                    style={[
                      styles.input,
                      {
                        color: palette.text,
                        borderColor: palette.border,
                        backgroundColor: palette.input,
                      },
                    ]}
                  />
                ) : null}
                <TextInput
                  value={nextAccountPasswordDraft}
                  onChangeText={setNextAccountPasswordDraft}
                  placeholder="새 로그인 비밀번호"
                  placeholderTextColor={palette.mutedText}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  textContentType="newPassword"
                  autoComplete="new-password"
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
                  value={confirmAccountPasswordDraft}
                  onChangeText={setConfirmAccountPasswordDraft}
                  placeholder="새 로그인 비밀번호 확인"
                  placeholderTextColor={palette.mutedText}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  textContentType="newPassword"
                  autoComplete="new-password"
                  style={[
                    styles.input,
                    {
                      color: palette.text,
                      borderColor: palette.border,
                      backgroundColor: palette.input,
                    },
                  ]}
                />
                {nextAccountPasswordValidationMessage ? (
                  <Text style={[styles.errorText, { color: palette.warning }]}>
                    {nextAccountPasswordValidationMessage}
                  </Text>
                ) : null}
                <View style={styles.modalActions}>
                  <Pressable
                    disabled={changingAccountPassword}
                    onPress={closeAccountPassword}
                    style={[
                      styles.secondaryButton,
                      {
                        backgroundColor: palette.surfaceAlt,
                        borderColor: palette.border,
                        opacity: changingAccountPassword ? 0.55 : 1,
                      },
                    ]}
                  >
                    <Text style={[styles.secondaryText, { color: palette.text }]}>
                      취소
                    </Text>
                  </Pressable>
                  <Pressable
                    disabled={!canChangeAccountPassword}
                    onPress={() => void handleChangeAccountPassword()}
                    style={[
                      styles.secondaryButton,
                      {
                        backgroundColor: palette.accent,
                        borderColor: palette.accent,
                        opacity: canChangeAccountPassword ? 1 : 0.55,
                      },
                    ]}
                  >
                    <Text style={[styles.secondaryText, styles.primaryButtonText]}>
                      {changingAccountPassword
                        ? "저장 중..."
                        : accountPasswordState === "set"
                          ? "비밀번호 변경"
                          : "비밀번호 설정"}
                    </Text>
                  </Pressable>
                </View>
              </View>
            </ScrollView>
          </KeyboardAvoidingView>
        </Modal>
      ) : null}
      {changePassphraseOpen &&
      showFullSettings &&
      vault.status === "unlocked" ? (
        <Modal
          animationType="fade"
          transparent
          visible
          onRequestClose={closeChangePassphrase}
        >
          <KeyboardAvoidingView
            style={[styles.modalOverlay, { backgroundColor: palette.overlay }]}
            behavior={Platform.OS === "ios" ? "padding" : "height"}
          >
            <ScrollView
              contentContainerStyle={styles.modalScrollContent}
              keyboardShouldPersistTaps="handled"
            >
              <View
                style={[
                  styles.modalCard,
                  {
                    backgroundColor: palette.surface,
                    borderColor: palette.border,
                  },
                ]}
              >
                <View style={styles.modalHeader}>
                  <Text style={[styles.modalTitle, { color: palette.text }]}>
                    동기화 암호 변경
                  </Text>
                  <Text style={[styles.body, { color: palette.mutedText }]}>
                    현재 암호를 확인한 후 새 암호로 변경합니다.
                  </Text>
                </View>
                <TextInput
                  value={currentPassphraseDraft}
                  onChangeText={setCurrentPassphraseDraft}
                  placeholder="현재 동기화 암호"
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
                  value={nextPassphraseDraft}
                  onChangeText={setNextPassphraseDraft}
                  placeholder="새 동기화 암호"
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
                  value={confirmPassphraseDraft}
                  onChangeText={setConfirmPassphraseDraft}
                  placeholder="새 동기화 암호 확인"
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
                {nextPassphraseValidationMessage ? (
                  <Text style={[styles.errorText, { color: palette.warning }]}>
                    {nextPassphraseValidationMessage}
                  </Text>
                ) : null}
                <View style={styles.modalActions}>
                  <Pressable
                    disabled={changingPassphrase}
                    onPress={closeChangePassphrase}
                    style={[
                      styles.secondaryButton,
                      {
                        backgroundColor: palette.surfaceAlt,
                        borderColor: palette.border,
                        opacity: changingPassphrase ? 0.55 : 1,
                      },
                    ]}
                  >
                    <Text style={[styles.secondaryText, { color: palette.text }]}>
                      취소
                    </Text>
                  </Pressable>
                  <Pressable
                    disabled={!canChangePassphrase}
                    onPress={() => void handleChangePassphrase()}
                    style={[
                      styles.secondaryButton,
                      {
                        backgroundColor: palette.accent,
                        borderColor: palette.accent,
                        opacity: canChangePassphrase ? 1 : 0.55,
                      },
                    ]}
                  >
                    <Text
                      style={[styles.secondaryText, styles.primaryButtonText]}
                    >
                      {changingPassphrase ? "변경 중..." : "암호 변경"}
                    </Text>
                  </Pressable>
                </View>
              </View>
            </ScrollView>
          </KeyboardAvoidingView>
        </Modal>
      ) : null}
    </ScrollView>
  );
}

export function SettingsScreen(): React.JSX.Element {
  const navigation = useNavigation<NavigationProp<MainTabParamList>>();

  const goBackToPreviousMainTab = useCallback(() => {
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }

    navigation.navigate("Home");
  }, [navigation]);

  return (
    <IosEdgeSwipeBack onBack={goBackToPreviousMainTab}>
      <SettingsContent mode="full" />
    </IosEdgeSwipeBack>
  );
}

export function AuthSettingsScreen(): React.JSX.Element {
  const navigation = useNavigation();

  return (
    <SettingsContent
      mode="auth"
      onServerUrlSaved={() => {
        if (navigation.canGoBack()) {
          navigation.goBack();
        }
      }}
    />
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  content: {
    gap: 14,
  },
  title: {
    fontSize: 28,
    fontWeight: "900",
  },
  section: {
    borderWidth: 1,
    borderRadius: 20,
    padding: 16,
    gap: 10,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: "800",
  },
  body: {
    fontSize: 14,
    lineHeight: 20,
  },
  infoText: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "700",
  },
  errorText: {
    fontSize: 13,
    fontWeight: "700",
  },
  row: {
    flexDirection: "row",
    gap: 10,
    flexWrap: "wrap",
  },
  input: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 14,
  },
  secondaryButton: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  secondaryText: {
    fontSize: 14,
    fontWeight: "700",
  },
  primaryButtonText: {
    color: "#ffffff",
  },
  modalOverlay: {
    flex: 1,
  },
  modalScrollContent: {
    flexGrow: 1,
    justifyContent: "center",
    padding: 24,
  },
  modalCard: {
    width: "100%",
    maxWidth: 460,
    alignSelf: "center",
    borderWidth: 1,
    borderRadius: 20,
    padding: 18,
    gap: 12,
  },
  modalHeader: {
    gap: 6,
    marginBottom: 2,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: "800",
  },
  modalActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
    marginTop: 2,
  },
  themeChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  themeChipText: {
    fontSize: 13,
    fontWeight: "700",
    textTransform: "capitalize",
  },
  listItem: {
    gap: 4,
  },
  listTitle: {
    fontSize: 14,
    fontWeight: "700",
  },
  listBody: {
    fontSize: 13,
    lineHeight: 18,
  },
});
