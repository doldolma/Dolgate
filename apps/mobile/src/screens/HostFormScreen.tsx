import React, { useMemo, useState } from "react";
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
} from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import type { NavigationProp, RouteProp } from "@react-navigation/native";
import { isSshHostRecord } from "@dolssh/shared-core";
import type { RootStackParamList } from "../navigation/RootNavigator";
import { useMobileAppStore } from "../store/useMobileAppStore";
import { useMobilePalette } from "../theme";
import { useTranslation } from "react-i18next";

type HostAuthType = "password" | "privateKey";
type CredentialMode = "preserve" | "replace" | "remove";

const AUTH_TYPE_OPTIONS: Array<{ value: HostAuthType; labelKey: string }> = [
  { value: "password", labelKey: "hostForm.auth.password" },
  { value: "privateKey", labelKey: "hostForm.auth.privateKey" },
];

// SSH 호스트 생성·수정 폼. 데스크톱 전용 고급 필드(jump host·환경변수·시작 명령 등)는
// 다루지 않는다 — 수정 시 스토어(saveHost)가 기존 값을 그대로 보존한다.
export function HostFormScreen(): React.JSX.Element {
  const { t: translate } = useTranslation();
  const palette = useMobilePalette();
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const route = useRoute<RouteProp<RootStackParamList, "HostForm">>();
  const hostId = route.params?.hostId;
  const hosts = useMobileAppStore((state) => state.hosts);
  const saveHost = useMobileAppStore((state) => state.saveHost);

  const existing = useMemo(() => {
    if (!hostId) {
      return null;
    }
    const found = hosts.find((host) => host.id === hostId);
    return found && isSshHostRecord(found) ? found : null;
  }, [hostId, hosts]);
  const initialAuthType: HostAuthType =
    existing?.authType === "privateKey" ? "privateKey" : "password";

  const [label, setLabel] = useState(existing?.label ?? "");
  const [hostname, setHostname] = useState(existing?.hostname ?? "");
  const [portDraft, setPortDraft] = useState(String(existing?.port ?? 22));
  const [username, setUsername] = useState(existing?.username ?? "");
  const [authType, setAuthType] = useState<HostAuthType>(initialAuthType);
  const [groupName, setGroupName] = useState(existing?.groupName ?? "");
  const [password, setPassword] = useState("");
  const [privateKeyPem, setPrivateKeyPem] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [credentialMode, setCredentialMode] = useState<CredentialMode>(
    existing?.secretRef && existing.authType === initialAuthType
      ? "preserve"
      : "replace",
  );
  const [saving, setSaving] = useState(false);

  const port = Number.parseInt(portDraft, 10);
  const validationMessage = (() => {
    if (!label.trim()) {
      return translate("hostForm.validation.name");
    }
    if (!hostname.trim()) {
      return translate("hostForm.validation.host");
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return translate("hostForm.validation.port");
    }
    if (!username.trim()) {
      return translate("hostForm.validation.username");
    }
    return null;
  })();
  const canSave = !saving && !validationMessage;

  const handleSave = async (): Promise<void> => {
    if (!canSave) {
      return;
    }
    setSaving(true);
    try {
      await saveHost({
        hostId,
        label,
        hostname,
        port,
        username,
        authType,
        groupName: groupName.trim() ? groupName : null,
        credentialMode,
        credentials: {
          password: authType === "password" ? password : undefined,
          privateKeyPem: authType === "privateKey" ? privateKeyPem : undefined,
          passphrase: authType === "privateKey" ? passphrase : undefined,
        },
      });
      navigation.goBack();
    } catch (error) {
      Alert.alert(
        translate(hostId ? "hostForm.editFailedTitle" : "hostForm.addFailedTitle"),
        error instanceof Error && error.message.trim()
          ? error.message
          : translate("hostForm.saveFailed"),
      );
    } finally {
      setSaving(false);
    }
  };

  const inputStyle = [
    styles.input,
    {
      color: palette.text,
      borderColor: palette.border,
      backgroundColor: palette.input,
    },
  ];

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { backgroundColor: palette.background }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View
          style={[
            styles.section,
            { backgroundColor: palette.surface, borderColor: palette.border },
          ]}
        >
          <Text style={[styles.sectionTitle, { color: palette.text }]}>
            {translate("hostForm.basicSection")}
          </Text>
          <TextInput
            value={label}
            onChangeText={setLabel}
            placeholder={translate("hostForm.namePlaceholder")}
            placeholderTextColor={palette.mutedText}
            autoCorrect={false}
            style={inputStyle}
          />
          <TextInput
            value={hostname}
            onChangeText={setHostname}
            placeholder={translate("hostForm.hostPlaceholder")}
            placeholderTextColor={palette.mutedText}
            autoCapitalize="none"
            autoCorrect={false}
            style={inputStyle}
          />
          <View style={styles.row}>
            <TextInput
              value={portDraft}
              onChangeText={setPortDraft}
              placeholder={translate("hostForm.portPlaceholder")}
              placeholderTextColor={palette.mutedText}
              keyboardType="number-pad"
              style={[...inputStyle, styles.portInput]}
            />
            <TextInput
              value={username}
              onChangeText={setUsername}
              placeholder={translate("hostForm.usernamePlaceholder")}
              placeholderTextColor={palette.mutedText}
              autoCapitalize="none"
              autoCorrect={false}
              style={[...inputStyle, styles.flexInput]}
            />
          </View>
          <TextInput
            value={groupName}
            onChangeText={setGroupName}
            placeholder={translate("hostForm.groupPlaceholder")}
            placeholderTextColor={palette.mutedText}
            autoCapitalize="none"
            autoCorrect={false}
            style={inputStyle}
          />
        </View>

        <View
          style={[
            styles.section,
            { backgroundColor: palette.surface, borderColor: palette.border },
          ]}
        >
          <Text style={[styles.sectionTitle, { color: palette.text }]}>
            {translate("hostForm.authSection")}
          </Text>
          <View style={styles.row}>
            {AUTH_TYPE_OPTIONS.map((option) => {
              const active = authType === option.value;
              return (
                <Pressable
                  key={option.value}
                  onPress={() => {
                    setAuthType(option.value);
                    setCredentialMode(
                      existing?.secretRef && existing.authType === option.value
                        ? "preserve"
                        : "replace",
                    );
                  }}
                  style={[
                    styles.authChip,
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
                      styles.authChipText,
                      { color: active ? palette.accent : palette.text },
                    ]}
                  >
                    {translate(option.labelKey)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {existing?.secretRef && existing.authType === authType ? (
            <View style={styles.credentialModeRow}>
              {(
                [
                  ["preserve", translate("hostForm.credential.preserve")],
                  ["replace", translate("hostForm.credential.replace")],
                  ["remove", translate("hostForm.credential.remove")],
                ] as Array<[CredentialMode, string]>
              ).map(([mode, modeLabel]) => {
                const active = credentialMode === mode;
                return (
                  <Pressable
                    key={mode}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    onPress={() => setCredentialMode(mode)}
                    style={[
                      styles.credentialModeButton,
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
                        styles.authChipText,
                        { color: active ? palette.accent : palette.text },
                      ]}
                    >
                      {modeLabel}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}
          {credentialMode === "preserve" ? (
            <Text
              style={[styles.helpText, { color: palette.mutedText }]}
            >
              {translate("hostForm.credential.preserveHint")}
            </Text>
          ) : credentialMode === "remove" ? (
            <Text
              style={[styles.helpText, { color: palette.mutedText }]}
            >
              {translate("hostForm.credential.removeHint")}
            </Text>
          ) : authType === "password" ? (
            <TextInput
              value={password}
              onChangeText={setPassword}
              placeholder={translate("hostForm.passwordPlaceholder")}
              placeholderTextColor={palette.mutedText}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              style={inputStyle}
            />
          ) : (
            <>
              <TextInput
                value={privateKeyPem}
                onChangeText={setPrivateKeyPem}
                placeholder={
                  translate("hostForm.privateKeyPlaceholder")
                }
                placeholderTextColor={palette.mutedText}
                multiline
                autoCapitalize="none"
                autoCorrect={false}
                style={[...inputStyle, styles.keyInput]}
              />
              <TextInput
                value={passphrase}
                onChangeText={setPassphrase}
                placeholder={translate("hostForm.passphrasePlaceholder")}
                placeholderTextColor={palette.mutedText}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                style={inputStyle}
              />
            </>
          )}
          <Text style={[styles.helpText, { color: palette.mutedText }]}>
            {translate("hostForm.syncHint")}
          </Text>
        </View>

        {validationMessage && (label || hostname || username) ? (
          <Text style={[styles.errorText, { color: palette.warning }]}>
            {validationMessage}
          </Text>
        ) : null}

        <Pressable
          disabled={!canSave}
          onPress={() => void handleSave()}
          style={[
            styles.saveButton,
            {
              backgroundColor: palette.accent,
              opacity: canSave ? 1 : 0.55,
            },
          ]}
        >
          <Text style={styles.saveText}>
            {saving
            ? translate("hostForm.saving")
            : hostId
              ? translate("hostForm.saveChanges")
              : translate("hostForm.addHost")}
          </Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  content: {
    padding: 18,
    gap: 14,
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
  input: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },
  row: {
    flexDirection: "row",
    gap: 10,
  },
  portInput: {
    width: 96,
  },
  flexInput: {
    flex: 1,
  },
  keyInput: {
    minHeight: 120,
    textAlignVertical: "top",
  },
  authChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  authChipText: {
    fontSize: 13,
    fontWeight: "700",
  },
  credentialModeRow: {
    flexDirection: "row",
    gap: 8,
  },
  credentialModeButton: {
    flex: 1,
    minHeight: 40,
    borderWidth: 1,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 8,
  },
  helpText: {
    fontSize: 12,
    lineHeight: 17,
  },
  errorText: {
    fontSize: 13,
    fontWeight: "700",
    paddingHorizontal: 4,
  },
  saveButton: {
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: "center",
  },
  saveText: {
    fontSize: 15,
    fontWeight: "800",
    color: "#F8FBFF",
  },
});
