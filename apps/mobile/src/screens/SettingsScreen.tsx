import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
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
import { openInAppBrowser } from "../lib/in-app-browser";
import {
  DEFAULT_SERVER_URL,
  PRIVACY_POLICY_URL,
  getSettingsValidationMessage,
} from "../lib/mobile";
import type { MainTabParamList } from "../navigation/RootNavigator";
import { useScreenPadding } from "../lib/screen-layout";
import { useMobileAppStore } from "../store/useMobileAppStore";
import { useMobilePalette } from "../theme";
import { getAccountPasswordValidationMessage, getNewVaultPassphraseMessage } from '../i18n/shared-messages';
import { useTranslation } from "react-i18next";
import { APP_LANGUAGE_OPTIONS } from "@dolssh/shared-core";

interface SettingsContentProps {
  mode: "auth" | "full";
  onServerUrlSaved?: () => void;
}

// 언어 이름은 그 언어로 적는다(자기 언어를 못 읽는 사용자가 없게).
const LANGUAGE_LABELS: Record<"ko" | "en", string> = {
  ko: "한국어",
  en: "English",
};

function SettingsContent({
  mode,
  onServerUrlSaved,
}: SettingsContentProps): React.JSX.Element {
  const { t: translate } = useTranslation();
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

  // 정책 문서는 앱 안의 브라우저 시트에서 띄운다 — 시스템 브라우저로 나가도 규정상 문제는
  // 없지만, 로그인과 같은 방식으로 앱 안에 머무는 편이 자연스럽다.
  const openPrivacyPolicy = useCallback((): void => {
    void openInAppBrowser(PRIVACY_POLICY_URL).catch(() => undefined);
  }, []);

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
        translate("settings.deleteAccount.failedTitle"),
        error instanceof Error && error.message.trim()
          ? error.message
          : translate("settings.deleteAccount.failed"),
      );
    } finally {
      setDeletingAccount(false);
    }
  };

  const nextAccountPasswordValidationMessage = nextAccountPasswordDraft
    ? getAccountPasswordValidationMessage(nextAccountPasswordDraft)
    : null;
  const canChangeAccountPassword =
    !changingAccountPassword &&
    (accountPasswordState === "unset" || accountPasswordState === "set") &&
    (accountPasswordState === "unset" ||
      currentAccountPasswordDraft.length > 0) &&
    getAccountPasswordValidationMessage(nextAccountPasswordDraft) === null &&
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
          ? translate("settings.accountPassword.changedTitle")
          : translate("settings.accountPassword.setTitle"),
      );
    } catch (error) {
      Alert.alert(
        isChanging
          ? translate("settings.accountPassword.changeFailedTitle")
          : translate("settings.accountPassword.setFailedTitle"),
        error instanceof Error && error.message.trim()
          ? error.message
          : translate("settings.accountPassword.saveFailed"),
      );
    } finally {
      setChangingAccountPassword(false);
    }
  };

  const canChangePassphrase =
    !changingPassphrase &&
    currentPassphraseDraft.length > 0 &&
    getNewVaultPassphraseMessage(nextPassphraseDraft) === null &&
    nextPassphraseDraft === confirmPassphraseDraft;
  const nextPassphraseValidationMessage = nextPassphraseDraft
    ? getNewVaultPassphraseMessage(nextPassphraseDraft)
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
      Alert.alert(translate("settings.vault.changedTitle"));
    } catch (error) {
      Alert.alert(
        translate("settings.vault.changeFailedTitle"),
        error instanceof Error && error.message.trim()
          ? error.message
          : translate("settings.vault.changeFailed"),
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
      translate("settings.deleteAccount.confirmTitle"),
      translate("settings.deleteAccount.confirmBody"),
      [
        { text: translate("common.cancel"), style: "cancel" },
        {
          text: translate("settings.deleteAccount.continue"),
          style: "destructive",
          onPress: () => {
            Alert.alert(
              translate("settings.deleteAccount.finalTitle"),
              translate("settings.deleteAccount.finalBody"),
              [
                { text: translate("common.cancel"), style: "cancel" },
                {
                  text: translate("settings.deleteAccount.permanentDelete"),
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
            {auth.session?.user.email ?? translate("settings.account.notSignedIn")}
          </Text>
          <Text style={[styles.body, { color: palette.mutedText }]}>
            {translate("settings.account.authStatus", { status: auth.status })}
          </Text>
          {showSyncStatus ? (
            <Text style={[styles.body, { color: palette.mutedText }]}>
              {translate("settings.account.syncStatus", { status: syncStatus.status })}
            </Text>
          ) : null}
          {auth.status === "offline-authenticated" ? (
            <Text style={[styles.infoText, { color: palette.warning }]}>
              {translate("settings.account.offlineCache")}
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
                    ? translate("settings.accountPassword.change")
                    : translate("settings.accountPassword.set")}
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
                {translate("settings.account.logout")}
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
                  {translate(deletingAccount ? "settings.deleteAccount.deleting" : "settings.deleteAccount.action")}
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
            {translate("settings.vault.title")}
          </Text>
          <Text style={[styles.body, { color: palette.mutedText }]}>
            {translate("settings.vault.isSet")}
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
              {translate("settings.vault.changePassphrase")}
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
              {translate("settings.server.save")}
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
              {translate("settings.server.restoreDefault")}
            </Text>
          </Pressable>
        </View>
      </View>

      {/* 언어 — 기본은 기기 언어를 따르고, 사용자가 직접 고를 수도 있다. */}
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
          {translate("settings.language.title")}
        </Text>
        <View style={styles.row}>
          {APP_LANGUAGE_OPTIONS.map((option) => {
            const active = (settings.language ?? "system") === option;
            return (
              <Pressable
                key={option}
                onPress={() => void updateSettings({ language: option })}
                style={[
                  styles.secondaryButton,
                  {
                    backgroundColor: active ? palette.accentSoft : palette.surfaceAlt,
                    borderColor: active ? palette.accent : palette.border,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.secondaryText,
                    { color: palette.text },
                  ]}
                >
                  {option === "system"
                    ? translate("settings.language.system")
                    : LANGUAGE_LABELS[option]}
                </Text>
              </Pressable>
            );
          })}
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
              {translate("settings.empty.knownHosts")}
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
              {translate("settings.empty.credentials")}
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
        {/* 이 섹션은 로그인 전(서버 설정) 화면에도 그려지므로, 로그인하지 않은 사용자도
            처리방침에 닿는다 — 5.1.1(i) 이 요구하는 "앱 안에서 쉽게 접근". */}
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={translate("common.privacyPolicy")}
          onPress={openPrivacyPolicy}
          style={[
            styles.secondaryButton,
            {
              backgroundColor: palette.surfaceAlt,
              borderColor: palette.border,
            },
          ]}
        >
          <Text style={[styles.secondaryText, { color: palette.text }]}>
            {translate("common.privacyPolicy")}
          </Text>
        </Pressable>
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
                    {translate(accountPasswordState === "set" ? "settings.accountPassword.sectionChange" : "settings.accountPassword.sectionSet")}
                  </Text>
                  <Text style={[styles.body, { color: palette.mutedText }]}>
                    {translate("settings.accountPassword.description")}
                  </Text>
                </View>
                {accountPasswordState === "set" ? (
                  <TextInput
                    value={currentAccountPasswordDraft}
                    onChangeText={setCurrentAccountPasswordDraft}
                    placeholder={translate("settings.accountPassword.currentPlaceholder")}
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
                  placeholder={translate("settings.accountPassword.newPlaceholder")}
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
                  placeholder={translate("settings.accountPassword.confirmPlaceholder")}
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
                      {translate("common.cancel")}
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
                        ? translate("settings.accountPassword.saving")
                        : accountPasswordState === "set"
                          ? translate("settings.accountPassword.change")
                          : translate("settings.accountPassword.set")}
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
                    {translate("settings.vault.changeTitle")}
                  </Text>
                  <Text style={[styles.body, { color: palette.mutedText }]}>
                    {translate("settings.vault.changeDescription")}
                  </Text>
                </View>
                <TextInput
                  value={currentPassphraseDraft}
                  onChangeText={setCurrentPassphraseDraft}
                  placeholder={translate("settings.vault.currentPlaceholder")}
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
                  placeholder={translate("settings.vault.newPlaceholder")}
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
                  placeholder={translate("settings.vault.confirmPlaceholder")}
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
                      {translate("common.cancel")}
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
                      {translate(changingPassphrase ? "settings.vault.changing" : "settings.vault.changePassphrase")}
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
