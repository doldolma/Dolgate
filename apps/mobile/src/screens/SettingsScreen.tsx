import React, { useEffect, useMemo, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  DEFAULT_SERVER_URL,
  getSettingsValidationMessage,
} from "../lib/mobile";
import { useScreenPadding } from "../lib/screen-layout";
import { useMobileAppStore } from "../store/useMobileAppStore";
import { useMobilePalette } from "../theme";

interface SettingsContentProps {
  mode: "auth" | "full";
}

function SettingsContent({ mode }: SettingsContentProps): React.JSX.Element {
  const palette = useMobilePalette();
  const screenPadding = useScreenPadding({
    includeSafeTop: mode !== "auth",
    topOffset: mode === "auth" ? 14 : 10,
  });
  const auth = useMobileAppStore((state) => state.auth);
  const settings = useMobileAppStore((state) => state.settings);
  const knownHosts = useMobileAppStore((state) => state.knownHosts);
  const secretMetadata = useMobileAppStore((state) => state.secretMetadata);
  const logout = useMobileAppStore((state) => state.logout);
  const updateSettings = useMobileAppStore((state) => state.updateSettings);

  const [serverUrlDraft, setServerUrlDraft] = useState(settings.serverUrl);

  useEffect(() => {
    setServerUrlDraft(settings.serverUrl);
  }, [settings.serverUrl]);

  const validationMessage = useMemo(
    () => getSettingsValidationMessage(serverUrlDraft),
    [serverUrlDraft],
  );

  const hasAuthenticatedSession =
    (auth.status === "authenticated" ||
      auth.status === "offline-authenticated") &&
    Boolean(auth.session);
  const showFullSettings = mode === "full" && hasAuthenticatedSession;
  const canSaveServerUrl = !validationMessage;

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
          <Pressable
            onPress={() => void logout()}
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
              로그아웃
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
            onPress={() => void updateSettings({ serverUrl: serverUrlDraft })}
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
            Theme
          </Text>
          <View style={styles.row}>
            {(["system", "dark", "light"] as const).map((theme) => {
              const active = settings.theme === theme;
              return (
                <Pressable
                  key={theme}
                  onPress={() => void updateSettings({ theme })}
                  style={[
                    styles.themeChip,
                    {
                      backgroundColor: active
                        ? palette.accentSoft
                        : palette.surfaceAlt,
                      borderColor: active ? palette.accent : palette.border,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.themeChipText,
                      {
                        color: active ? palette.accent : palette.text,
                      },
                    ]}
                  >
                    {theme}
                  </Text>
                </Pressable>
              );
            })}
          </View>
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
    </ScrollView>
  );
}

export function SettingsScreen(): React.JSX.Element {
  return <SettingsContent mode="full" />;
}

export function AuthSettingsScreen(): React.JSX.Element {
  return <SettingsContent mode="auth" />;
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
