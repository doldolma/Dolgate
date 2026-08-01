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
import { SettingsGroup, SettingsRow } from "../components/SettingsList";
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
import { APP_LANGUAGE_OPTIONS, type AppLanguage } from "@dolssh/shared-core";

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
  const [languagePickerOpen, setLanguagePickerOpen] = useState(false);
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
  const canSaveServerUrl = !validationMessage && !savingServerUrl;

  // 정책 문서는 앱 안의 브라우저 시트에서 띄운다 — 시스템 브라우저로 나가도 규정상 문제는
  // 없지만, 로그인과 같은 방식으로 앱 안에 머무는 편이 자연스럽다.
  const openPrivacyPolicy = useCallback((): void => {
    void openInAppBrowser(PRIVACY_POLICY_URL).catch(() => undefined);
  }, []);

  const closeLanguagePicker = useCallback((): void => {
    setLanguagePickerOpen(false);
  }, []);

  const currentLanguage: AppLanguage = settings.language ?? "system";
  const languageOptionLabel = useCallback(
    (option: AppLanguage): string =>
      option === "system"
        ? translate("settings.language.system")
        : LANGUAGE_LABELS[option],
    [translate],
  );

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

  // 로그아웃은 이 기기의 시크릿·볼트 키·호스트까지 지운다(resetToSignedOutState). 되돌릴 수는
  // 있지만 다시 로그인·잠금해제를 거쳐야 하므로, 목록에서 잘못 눌린 것으로 실행되게 두지 않는다.
  const confirmLogout = (): void => {
    Alert.alert(
      translate("settings.account.logoutConfirmTitle"),
      translate("settings.account.logoutConfirmBody"),
      [
        { text: translate("common.cancel"), style: "cancel" },
        {
          text: translate("settings.account.logout"),
          style: "destructive",
          onPress: () => void logout(),
        },
      ],
    );
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
        <SettingsGroup
          header={translate("settings.sections.account")}
          footer={
            auth.errorMessage ??
            syncStatus.errorMessage ??
            (auth.status === "offline-authenticated"
              ? translate("settings.account.offlineCache")
              : undefined)
          }
          footerTone={
            auth.errorMessage || syncStatus.errorMessage ? "danger" : "warning"
          }
        >
          <SettingsRow
            icon="person-outline"
            label={
              auth.session?.user.email ??
              translate("settings.account.notSignedIn")
            }
          />
          <SettingsRow
            icon="shield-checkmark-outline"
            label={translate("settings.account.statusLabel")}
            value={translate(`settings.account.status.${auth.status}`)}
          />
          {/* 30초 폴링이 status 를 ready→syncing→ready 로 돌린다. 이 행을 조건부로 빼면
              그때마다 카드 높이가 바뀌어 화면이 위아래로 흔들린다 — 행은 항상 두고 값만
              바꾼다. */}
          <SettingsRow
            icon="sync-outline"
            label={translate("settings.account.syncLabel")}
            value={translate(`settings.account.sync.${syncStatus.status}`)}
          />
          {accountPasswordState === "set" ||
          accountPasswordState === "unset" ? (
            <SettingsRow
              chevron
              icon="key-outline"
              label={
                accountPasswordState === "set"
                  ? translate("settings.accountPassword.change")
                  : translate("settings.accountPassword.set")
              }
              onPress={openAccountPassword}
            />
          ) : null}
        </SettingsGroup>
      ) : null}

      {/* 로그아웃·탈퇴는 각자 자기 카드에 둔다 — 되돌릴 수 없는 동작을 목록 안의 다른 행과
          나란히 놓지 않는 게 이 리스트 구조의 규칙이다. */}
      {showFullSettings ? (
        <SettingsGroup>
          <SettingsRow
            align="center"
            label={translate("settings.account.logout")}
            tone="accent"
            onPress={confirmLogout}
          />
        </SettingsGroup>
      ) : null}

      {showFullSettings && auth.status === "authenticated" ? (
        <SettingsGroup>
          <SettingsRow
            align="center"
            disabled={deletingAccount}
            label={translate(
              deletingAccount
                ? "settings.deleteAccount.deleting"
                : "settings.deleteAccount.action",
            )}
            tone="danger"
            onPress={confirmDeleteAccount}
          />
        </SettingsGroup>
      ) : null}

      {showFullSettings && vault.status === "unlocked" ? (
        <SettingsGroup
          header={translate("settings.vault.title")}
          footer={translate("settings.vault.isSet")}
        >
          <SettingsRow
            chevron
            icon="lock-closed-outline"
            label={translate("settings.vault.changePassphrase")}
            onPress={openChangePassphrase}
          />
        </SettingsGroup>
      ) : null}

      <SettingsGroup
        header={translate("settings.sections.server")}
        footer={
          showFullSettings
            ? translate("settings.server.signedInHint")
            : (validationMessage ?? undefined)
        }
        footerTone={showFullSettings ? "muted" : "danger"}
      >
        {showFullSettings ? (
          // 로그인한 뒤에는 보여주기만 한다 — 세션·볼트가 이 서버에 묶여 있어서 여기서
          // 바꾼다고 갈아탈 수 있는 게 아니다. 서버는 로그인 화면에서 고른다.
          <SettingsRow icon="cloud-outline">
            <Text selectable style={[styles.rowText, { color: palette.text }]}>
              {settings.serverUrl}
            </Text>
          </SettingsRow>
        ) : (
          <SettingsRow icon="cloud-outline">
            <TextInput
              value={serverUrlDraft}
              onChangeText={setServerUrlDraft}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="https://ssh.doldolma.com"
              placeholderTextColor={palette.mutedText}
              style={[styles.rowText, { color: palette.text }]}
            />
          </SettingsRow>
        )}
        {showFullSettings ? null : (
          <SettingsRow
            align="center"
            disabled={!canSaveServerUrl}
            label={translate("settings.server.save")}
            tone="accent"
            onPress={() => void handleSaveServerUrl()}
          />
        )}
        {showFullSettings ? null : (
          <SettingsRow
            align="center"
            label={translate("settings.server.restoreDefault")}
            tone="accent"
            onPress={() => {
              setServerUrlDraft(DEFAULT_SERVER_URL);
              void updateSettings({ serverUrl: DEFAULT_SERVER_URL });
            }}
          />
        )}
      </SettingsGroup>

      {/* 언어 — 기본은 기기 언어를 따르고, 사용자가 직접 고를 수도 있다. */}
      <SettingsGroup header={translate("settings.language.title")}>
        <SettingsRow
          accessibilityLabel={translate("settings.language.title")}
          accessibilityValue={{ text: languageOptionLabel(currentLanguage) }}
          chevron
          icon="language-outline"
          label={languageOptionLabel(currentLanguage)}
          onPress={() => setLanguagePickerOpen(true)}
        />
      </SettingsGroup>

      {/* known host 지문과 자격증명 이름을 늘어놓으면 화면 대부분이 디버그 목록이 된다 —
          개수만 보여준다. */}
      {showFullSettings ? (
        <SettingsGroup header={translate("settings.sections.security")}>
          <SettingsRow
            icon="finger-print-outline"
            label={translate("settings.knownHosts")}
            value={String(knownHosts.length)}
          />
          <SettingsRow
            icon="shield-outline"
            label={translate("settings.credentials")}
            value={String(secretMetadata.length)}
          />
        </SettingsGroup>
      ) : null}

      <SettingsGroup header={translate("settings.sections.app")}>
        <SettingsRow
          icon="information-circle-outline"
          label={translate("settings.version")}
          value={APP_VERSION}
        />
        {/* 이 그룹은 로그인 전(서버 설정) 화면에도 그려지므로, 로그인하지 않은 사용자도
            처리방침에 닿는다 — 5.1.1(i) 이 요구하는 "앱 안에서 쉽게 접근". */}
        <SettingsRow
          accessibilityRole="link"
          chevron
          icon="document-text-outline"
          label={translate("common.privacyPolicy")}
          onPress={openPrivacyPolicy}
        />
      </SettingsGroup>
      {languagePickerOpen ? (
        <Modal
          animationType="fade"
          transparent
          visible
          onRequestClose={closeLanguagePicker}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={translate("common.close")}
            onPress={closeLanguagePicker}
            style={[
              styles.sheetBackdrop,
              {
                backgroundColor: palette.overlay,
                // 시트는 탭바·홈 인디케이터 위로 떠야 한다 — 모달이 탭바를 덮으므로 기기
                // 하단 여백만큼 띄우지 않으면 마지막 항목이 탭바에 맞붙어 보인다.
                paddingBottom: Math.max(screenPadding.paddingBottom, 14),
              },
            ]}
          >
            {/* 목록과 취소를 따로 떼어 놓는 건 iOS 액션 시트의 구성이다. */}
            <Pressable
              onPress={(event) => event.stopPropagation()}
              style={styles.sheetBody}
            >
              <SettingsGroup solid>
                {/* 제목은 카드 안에 넣는다 — 회색 머리글로 카드 위에 띄우면 뒤에 깔린
                    화면 글자와 겹쳐 보인다. */}
                <SettingsRow>
                  <Text
                    style={[styles.sheetHeading, { color: palette.mutedText }]}
                  >
                    {translate("settings.language.title")}
                  </Text>
                </SettingsRow>
                {APP_LANGUAGE_OPTIONS.map((option) => {
                  const active = currentLanguage === option;
                  return (
                    <SettingsRow
                      key={option}
                      check={active}
                      label={languageOptionLabel(option)}
                      tone={active ? "accent" : "default"}
                      onPress={() => {
                        closeLanguagePicker();
                        if (!active) {
                          void updateSettings({ language: option });
                        }
                      }}
                    />
                  );
                })}
              </SettingsGroup>
              <SettingsGroup solid>
                <SettingsRow
                  align="center"
                  label={translate("common.cancel")}
                  tone="accent"
                  onPress={closeLanguagePicker}
                />
              </SettingsGroup>
            </Pressable>
          </Pressable>
        </Modal>
      ) : null}
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
              {/* 폼은 목록이 아니다 — 입력칸은 테두리와 배경으로 "여기 입력한다"를 보여줘야
                  하고, 주 동작은 채워진 버튼이어야 누를 것으로 읽힌다. */}
              <View
                style={[
                  styles.formCard,
                  { backgroundColor: palette.surfaceSolid },
                ]}
              >
                <View style={styles.formHeader}>
                  <Text style={[styles.formTitle, { color: palette.text }]}>
                    {translate(accountPasswordState === "set" ? "settings.accountPassword.sectionChange" : "settings.accountPassword.sectionSet")}
                  </Text>
                  <Text
                    style={[styles.formDescription, { color: palette.mutedText }]}
                  >
                    {translate("settings.accountPassword.description")}
                  </Text>
                </View>

                <View style={styles.formFields}>
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
                        styles.formInput,
                        {
                          color: palette.text,
                          backgroundColor: palette.input,
                          borderColor: palette.border,
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
                      styles.formInput,
                      {
                        color: palette.text,
                        backgroundColor: palette.input,
                        borderColor: palette.border,
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
                      styles.formInput,
                      {
                        color: palette.text,
                        backgroundColor: palette.input,
                        borderColor: palette.border,
                      },
                    ]}
                  />
                </View>

                {nextAccountPasswordValidationMessage ? (
                  <Text style={[styles.formHint, { color: palette.warning }]}>
                    {nextAccountPasswordValidationMessage}
                  </Text>
                ) : null}

                <View style={styles.formActions}>
                  <Pressable
                    disabled={!canChangeAccountPassword}
                    onPress={() => void handleChangeAccountPassword()}
                    style={[
                      styles.formPrimary,
                      {
                        backgroundColor: !canChangeAccountPassword
                          ? palette.surfaceAlt
                          : palette.accent,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.formPrimaryText,
                        {
                          color: !canChangeAccountPassword
                            ? palette.tabInactive
                            : "#FFFFFF",
                        },
                      ]}
                    >
                      {changingAccountPassword
                        ? translate("settings.accountPassword.saving")
                        : accountPasswordState === "set"
                          ? translate("settings.accountPassword.change")
                          : translate("settings.accountPassword.set")}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={closeAccountPassword}
                    style={styles.formCancel}
                  >
                    <Text
                      style={[styles.formCancelText, { color: palette.accent }]}
                    >
                      {translate("common.cancel")}
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
              {/* 폼은 목록이 아니다 — 입력칸은 테두리와 배경으로 "여기 입력한다"를 보여줘야
                  하고, 주 동작은 채워진 버튼이어야 누를 것으로 읽힌다. */}
              <View
                style={[
                  styles.formCard,
                  { backgroundColor: palette.surfaceSolid },
                ]}
              >
                <View style={styles.formHeader}>
                  <Text style={[styles.formTitle, { color: palette.text }]}>
                    {translate("settings.vault.changeTitle")}
                  </Text>
                  <Text
                    style={[styles.formDescription, { color: palette.mutedText }]}
                  >
                    {translate("settings.vault.changeDescription")}
                  </Text>
                </View>

                <View style={styles.formFields}>
                  <TextInput
                    value={currentPassphraseDraft}
                    onChangeText={setCurrentPassphraseDraft}
                    placeholder={translate("settings.vault.currentPlaceholder")}
                    placeholderTextColor={palette.mutedText}
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={[
                      styles.formInput,
                      {
                        color: palette.text,
                        backgroundColor: palette.input,
                        borderColor: palette.border,
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
                      styles.formInput,
                      {
                        color: palette.text,
                        backgroundColor: palette.input,
                        borderColor: palette.border,
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
                      styles.formInput,
                      {
                        color: palette.text,
                        backgroundColor: palette.input,
                        borderColor: palette.border,
                      },
                    ]}
                  />
                </View>

                {nextPassphraseValidationMessage ? (
                  <Text style={[styles.formHint, { color: palette.warning }]}>
                    {nextPassphraseValidationMessage}
                  </Text>
                ) : null}

                <View style={styles.formActions}>
                  <Pressable
                    disabled={!canChangePassphrase}
                    onPress={() => void handleChangePassphrase()}
                    style={[
                      styles.formPrimary,
                      {
                        backgroundColor: !canChangePassphrase
                          ? palette.surfaceAlt
                          : palette.accent,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.formPrimaryText,
                        {
                          color: !canChangePassphrase
                            ? palette.tabInactive
                            : "#FFFFFF",
                        },
                      ]}
                    >
                      {translate(changingPassphrase ? "settings.vault.changing" : "settings.vault.changePassphrase")}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={closeChangePassphrase}
                    style={styles.formCancel}
                  >
                    <Text
                      style={[styles.formCancelText, { color: palette.accent }]}
                    >
                      {translate("common.cancel")}
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
    gap: 18,
  },
  // iOS large title 규격(34pt bold) — 아래 그룹 리스트와 같은 결로 맞춘다.
  title: {
    fontSize: 34,
    fontWeight: "700",
    letterSpacing: -0.6,
  },
  // 그룹 행을 통째로 채우는 텍스트·입력칸 — 행이 이미 여백을 갖고 있어 자기 테두리는 없다.
  rowText: {
    flex: 1,
    fontSize: 17,
    letterSpacing: -0.2,
    paddingVertical: 0,
  },
  modalOverlay: {
    flex: 1,
  },
  modalScrollContent: {
    flexGrow: 1,
    justifyContent: "center",
    padding: 20,
  },
  formCard: {
    width: "100%",
    maxWidth: 460,
    alignSelf: "center",
    borderRadius: 22,
    padding: 20,
    gap: 18,
  },
  formHeader: {
    gap: 6,
  },
  formTitle: {
    fontSize: 19,
    fontWeight: "700",
    letterSpacing: -0.3,
  },
  formDescription: {
    fontSize: 13,
    lineHeight: 18,
  },
  formFields: {
    gap: 10,
  },
  // 입력칸은 테두리와 배경을 갖는다 — 상자가 없으면 목록 항목처럼 읽혀 어디에 입력하는지
  // 알 수 없다.
  formInput: {
    minHeight: 48,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  formHint: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "500",
    marginTop: -6,
  },
  formActions: {
    gap: 4,
  },
  // 주 동작은 채워진 버튼 — 글자만 두면 누를 것으로 읽히지 않는다.
  formPrimary: {
    minHeight: 50,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  formPrimaryText: {
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: -0.2,
  },
  formCancel: {
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  formCancelText: {
    fontSize: 16,
    fontWeight: "600",
    letterSpacing: -0.2,
  },
  sheetBackdrop: {
    flex: 1,
    justifyContent: "flex-end",
    padding: 14,
  },
  sheetBody: {
    gap: 12,
  },
  sheetHeading: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
    textAlign: "center",
  },
});
