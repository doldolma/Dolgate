import React, { useEffect, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { formatRelativeTime } from "../lib/mobile";
import { useMobileAppStore } from "../store/useMobileAppStore";
import { useMobilePalette } from "../theme";

export function SettingsScreen(): React.JSX.Element {
  const palette = useMobilePalette();
  const auth = useMobileAppStore((state) => state.auth);
  const settings = useMobileAppStore((state) => state.settings);
  const syncStatus = useMobileAppStore((state) => state.syncStatus);
  const knownHosts = useMobileAppStore((state) => state.knownHosts);
  const secretMetadata = useMobileAppStore((state) => state.secretMetadata);
  const startBrowserLogin = useMobileAppStore((state) => state.startBrowserLogin);
  const logout = useMobileAppStore((state) => state.logout);
  const syncNow = useMobileAppStore((state) => state.syncNow);
  const updateSettings = useMobileAppStore((state) => state.updateSettings);

  const [serverUrlDraft, setServerUrlDraft] = useState(settings.serverUrl);

  useEffect(() => {
    setServerUrlDraft(settings.serverUrl);
  }, [settings.serverUrl]);

  return (
    <ScrollView
      style={[
        styles.screen,
        {
          backgroundColor: palette.background,
        },
      ]}
      contentContainerStyle={styles.content}
    >
      <Text style={[styles.title, { color: palette.text }]}>Settings</Text>

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
          auth: {auth.status}
        </Text>
        {auth.errorMessage ? (
          <Text style={[styles.errorText, { color: palette.danger }]}>
            {auth.errorMessage}
          </Text>
        ) : null}
        <View style={styles.row}>
          {auth.session ? (
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
          ) : (
            <Pressable
              onPress={() => void startBrowserLogin()}
              style={[
                styles.primaryButton,
                {
                  backgroundColor: palette.accent,
                },
              ]}
            >
              <Text style={styles.primaryText}>로그인</Text>
            </Pressable>
          )}
          <Pressable
            onPress={() => void syncNow()}
            style={[
              styles.secondaryButton,
              {
                backgroundColor: palette.surfaceAlt,
                borderColor: palette.border,
              },
            ]}
          >
            <Text style={[styles.secondaryText, { color: palette.text }]}>
              동기화
            </Text>
          </Pressable>
        </View>
      </View>

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
          Sync server
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
        <Pressable
          onPress={() => void updateSettings({ serverUrl: serverUrlDraft })}
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
            서버 주소 저장
          </Text>
        </Pressable>
        <Text style={[styles.body, { color: palette.mutedText }]}>
          status: {syncStatus.status}
          {syncStatus.lastSuccessfulSyncAt
            ? ` • ${formatRelativeTime(syncStatus.lastSuccessfulSyncAt)}`
            : ""}
        </Text>
        {syncStatus.errorMessage ? (
          <Text style={[styles.errorText, { color: palette.danger }]}>
            {syncStatus.errorMessage}
          </Text>
        ) : null}
      </View>

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
        {knownHosts.slice(0, 8).map((record) => (
          <View key={record.id} style={styles.listItem}>
            <Text style={[styles.listTitle, { color: palette.text }]}>
              {record.host}:{record.port}
            </Text>
            <Text style={[styles.listBody, { color: palette.mutedText }]}>
              {record.algorithm} • {formatRelativeTime(record.updatedAt)}
            </Text>
          </View>
        ))}
        {knownHosts.length === 0 ? (
          <Text style={[styles.body, { color: palette.mutedText }]}>
            아직 신뢰된 호스트 키가 없습니다.
          </Text>
        ) : null}
      </View>

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
        {secretMetadata.slice(0, 8).map((record) => (
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
        ))}
        {secretMetadata.length === 0 ? (
          <Text style={[styles.body, { color: palette.mutedText }]}>
            아직 저장된 자격 증명이 없습니다.
          </Text>
        ) : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  content: {
    padding: 18,
    gap: 14,
    paddingBottom: 32,
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
    fontSize: 15,
  },
  primaryButton: {
    borderRadius: 14,
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  primaryText: {
    color: "#04111A",
    fontSize: 15,
    fontWeight: "900",
  },
  secondaryButton: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  secondaryText: {
    fontSize: 15,
    fontWeight: "800",
  },
  themeChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  themeChipText: {
    fontSize: 13,
    fontWeight: "800",
  },
  listItem: {
    gap: 2,
  },
  listTitle: {
    fontSize: 15,
    fontWeight: "700",
  },
  listBody: {
    fontSize: 13,
    lineHeight: 18,
  },
});
